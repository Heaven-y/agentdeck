import path from 'node:path';
import {
  nativeFeaturesFor,
  type AgentCapabilities,
  type AgentKind,
  type AgentModel,
  type AntigravityConnection,
  type CapabilitySelection,
} from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import type { CapabilityProvider, NativeCapabilityCatalog, NativeInvocation } from '../../agents/capability-types';
import { SessionError } from '../../agents/errors';
import { createModelCache, type CachedModelCatalog, type ModelCacheWriteGuard } from './model-cache';
import { createCapabilityRetention } from './capability-memory';

type Entry = NativeCapabilityCatalog['entries'][number];
function typedCommand(text: string): { name: string; text: string } | undefined {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!, text: match[2] ?? '' } : undefined;
}
function chooseEntry(entries: Entry[], selection?: CapabilitySelection, name?: string): Entry {
  const exact = entries.filter((entry) => (selection ? entry.id === selection.id : entry.name === name));
  const matches = exact.length || selection ? exact : entries.filter((entry) => entry.aliases?.includes(name ?? ''));
  if (matches.length !== 1)
    throw new SessionError(400, 'capability_missing', '技能或命令已变化、未知或存在歧义，请从当前能力列表重新选择');
  const entry = matches[0]!;
  if (!entry.available || !entry.invocation)
    throw new SessionError(
      400,
      'capability_unavailable',
      entry.unavailableReason ?? '此能力尚未接入网页，请使用本机 CLI',
    );
  return entry;
}

const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

function providerOf(providers: Partial<Record<AgentKind, CapabilityProvider>>, agent: AgentKind): CapabilityProvider {
  const provider = providers[agent];
  if (!provider) throw new SessionError(503, 'agent_unavailable', `${AGENT_LABELS[agent]} 适配器尚未接入`);
  return provider;
}

function prepareEntry(entry: Entry, args: string, sessionId?: string) {
  if (entry.requiresSession && !sessionId)
    throw new SessionError(400, 'session_required', '此命令需要已有会话，请先开始或打开一段对话');
  if (!entry.supportsArguments && args.trim())
    throw new SessionError(400, 'arguments_unsupported', '此命令不接受附加参数，请清空输入后调用');
  return { text: args, invocation: structuredClone(entry.invocation) };
}

function retainModels(partial: AgentModel[], previous: AgentModel[]): AgentModel[] {
  const ids = new Set(partial.map((model) => model.id));
  return [...partial, ...previous.filter((model) => !ids.has(model.id))];
}

function keyOf(directory: string, agent: AgentKind, connection?: AntigravityConnection) {
  const dir = path.resolve(directory);
  const scope = [agent, process.platform === 'win32' ? dir.toLowerCase() : dir];
  if (agent === 'antigravity' && connection) scope.push(connection);
  return JSON.stringify(scope);
}

function workspaceKey(key: string) {
  const [agent, directory, connection] = JSON.parse(key) as [AgentKind, string, AntigravityConnection?];
  return connection ? JSON.stringify([agent, directory]) : key;
}

export function createCapabilitiesService(
  providers: Partial<Record<AgentKind, CapabilityProvider>>,
  options: { configDir?: string; antigravityConnection?: () => Promise<AntigravityConnection | undefined> } = {},
) {
  const cache = new Map<string, NativeCapabilityCatalog>();
  const models = new Map<string, CachedModelCatalog | undefined>();
  const refreshing = new Map<string, symbol>();
  const reading = new Map<string, Promise<void>>();
  const restoring = new Map<string, Promise<AgentCapabilities>>();
  // 只记曾经发现的目录身份，正文目录回收后可在显式执行时重新校验命令。
  const evictedCommands = new Set<string>();
  // 命令仍按工作区/CLI 使用最近发现的入口，不因只读切换模型目录而改变发送前校验。
  const commandKeys = new Map<string, string>();
  const revisions: Partial<Record<AgentKind, number>> = {};
  const disk = options.configDir ? createModelCache(options.configDir) : undefined;
  const retention = createCapabilityRetention(
    (key) => reading.has(key) || refreshing.has(workspaceKey(key)),
    (key) => {
      const scope = workspaceKey(key);
      if (commandKeys.get(scope) === key) {
        commandKeys.delete(scope);
        evictedCommands.add(scope);
        if (evictedCommands.size > 128) evictedCommands.delete(evictedCommands.values().next().value!);
      }
      cache.delete(key);
      models.delete(key);
    },
  );
  async function resolveConnection() {
    try {
      return await options.antigravityConnection?.();
    } catch {
      // 设置不可读不等于使用账号模式，不用任何已知模式的缓存代替。
      return undefined;
    }
  }
  function publicCatalog(
    agent: AgentKind,
    catalog?: NativeCapabilityCatalog,
    savedModels?: CachedModelCatalog,
    connection?: AntigravityConnection,
  ): AgentCapabilities {
    if (!catalog)
      return {
        agent,
        discovered: savedModels?.current ?? false,
        commandsDiscovered: false,
        ...structuredClone(savedModels?.snapshot ?? { models: [] }),
        ...(connection ? { antigravityConnection: connection } : {}),
        features: nativeFeaturesFor(agent),
        entries: [],
        warnings: savedModels ? [] : ['打开模型菜单或点击刷新即可读取 CLI 能力。'],
      };
    const visible = structuredClone(catalog);
    return {
      ...visible,
      agent,
      discovered: true,
      commandsDiscovered: true,
      entries: visible.entries.map((entry) => {
        delete entry.invocation;
        return entry;
      }),
    };
  }
  async function discover(directory: string, agent: AgentKind, signal?: AbortSignal) {
    try {
      signal?.throwIfAborted();
      const catalog = await providerOf(providers, agent)(directory, signal);
      signal?.throwIfAborted();
      return catalog;
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError(
        503,
        'capabilities_unavailable',
        `${AGENT_LABELS[agent]} 能力读取失败，请检查本机运行时与配置`,
      );
    }
  }
  function loadSaved(key: string, agent: AgentKind, connection?: AntigravityConnection) {
    if ((agent === 'antigravity' && !connection) || cache.has(key) || models.has(key)) return;
    let pending = reading.get(key);
    if (!pending) {
      pending = readSaved(key, agent);
      reading.set(key, pending);
    }
    return pending;
  }
  function cachedCatalog(key: string, agent: AgentKind, connection?: AntigravityConnection) {
    retention.touch(key);
    const catalog = publicCatalog(agent, cache.get(key), models.get(key), connection);
    if (agent === 'antigravity' && !connection) catalog.discovered = false;
    return catalog;
  }
  async function readDirectory(directory: string, agent: AgentKind): Promise<AgentCapabilities> {
    const connection = agent === 'antigravity' ? await resolveConnection() : undefined;
    const key = keyOf(directory, agent, connection);
    const pending = loadSaved(key, agent, connection);
    if (pending) {
      await pending;
      if (agent === 'antigravity') {
        const current = await resolveConnection();
        // 等待磁盘时可能切换了连接；不返回刚读到的旧模式，也不启动新的发现。
        if (current !== connection) return cachedCatalog(keyOf(directory, agent, current), agent, current);
      }
    }
    return cachedCatalog(key, agent, connection);
  }
  async function readSaved(key: string, agent: AgentKind) {
    const revision = revisions[agent];
    const saved = await disk?.read(agent, key);
    if (revision === revisions[agent] && !cache.has(key)) {
      models.set(key, saved);
      retention.record(key, agent, saved);
    }
    // 失效后新发起的读取不能被旧 Promise 清理；旧结果也不登记内存。
    if (revision === revisions[agent]) reading.delete(key);
    retention.trim(agent);
  }
  async function updateModels(
    agent: AgentKind,
    key: string,
    catalog: NativeCapabilityCatalog,
    guard: ModelCacheWriteGuard,
  ) {
    // ChatGPT 目录不覆盖原先 API Key／自定义服务的磁盘目录。认证信息只保留在当次发现的内存结果。
    if (catalog.codexAccount) return;
    if (catalog.modelWarning) return retainPreviousModels(agent, key, catalog);
    if (catalog.models.length || !catalog.warnings.length || catalog.modelWarning === '')
      await disk?.write(agent, key, catalog, guard);
  }
  async function retainPreviousModels(agent: AgentKind, key: string, catalog: NativeCapabilityCatalog) {
    await loadSaved(key, agent, catalog.antigravityConnection);
    const previous = cachedCatalog(key, agent, catalog.antigravityConnection);
    if (previous.codexAccount) return;
    catalog.models = retainModels(catalog.models, previous.models);
    catalog.defaultModel ??= previous.defaultModel;
    if (catalog.defaultModel === previous.defaultModel)
      catalog.defaultReasoningEffort ??= previous.defaultReasoningEffort;
  }
  function retainCatalog(agent: AgentKind, key: string, catalog: NativeCapabilityCatalog, reusable: boolean) {
    // 未知连接的模型只在本次返回；保留不依赖模型来源的命令供显式调用。
    const retained = reusable
      ? catalog
      : {
          entries: catalog.entries,
          commandWarnings: catalog.commandWarnings,
          features: catalog.features,
          models: [],
          warnings: [],
        };
    const scope = workspaceKey(key);
    commandKeys.set(scope, key);
    cache.set(key, retained);
    evictedCommands.delete(scope);
    models.delete(key);
    retention.record(key, agent, retained);
  }
  async function refreshDirectory(
    directory: string,
    agent: AgentKind,
    signal?: AbortSignal,
  ): Promise<AgentCapabilities> {
    // 先登记请求再读连接：迟到的设置读取不能反过来替代后发刷新，保存也可立即使其失效。
    const scope = keyOf(directory, agent);
    const request = Symbol();
    refreshing.set(scope, request);
    const currentRequest = () => refreshing.get(scope) === request && !signal?.aborted;
    const assertCurrent = (sameConnection = true) => {
      signal?.throwIfAborted();
      if (!sameConnection || !currentRequest())
        throw new SessionError(
          409,
          'capabilities_refresh_superseded',
          '能力配置已变化或已有较新的刷新，请读取最新目录',
        );
    };
    try {
      const hasResolver = agent === 'antigravity' && !!options.antigravityConnection;
      const connection = hasResolver ? await resolveConnection() : undefined;
      const currentScope = hasResolver ? async () => (await resolveConnection()) === connection : undefined;
      if (refreshing.get(scope) !== request) assertCurrent();
      const key = keyOf(directory, agent, connection);
      const catalog = structuredClone(await discover(directory, agent, signal));
      assertCurrent(!hasResolver || catalog.antigravityConnection === connection);
      const reusable = agent !== 'antigravity' || connection !== undefined;
      if (reusable) await updateModels(agent, key, catalog, { currentRequest, currentScope });
      assertCurrent(!currentScope || (await currentScope()));
      retainCatalog(agent, key, catalog, reusable);
      return publicCatalog(agent, catalog);
    } finally {
      if (refreshing.get(scope) === request) refreshing.delete(scope);
      retention.trim(agent);
    }
  }
  async function commandCatalog(directory: string, agent: AgentKind, signal?: AbortSignal) {
    const key = keyOf(directory, agent);
    if (evictedCommands.has(key)) {
      let pending = restoring.get(key);
      if (!pending) {
        pending = refreshDirectory(directory, agent).finally(() => {
          if (restoring.get(key) === pending) restoring.delete(key);
        });
        restoring.set(key, pending);
      }
      await pending;
    }
    signal?.throwIfAborted();
    const commandKey = commandKeys.get(key);
    const catalog = commandKey ? cache.get(commandKey) : undefined;
    if (!commandKey || !catalog)
      throw new SessionError(409, 'capabilities_not_refreshed', '请先点击“刷新能力”，再使用技能或斜杠命令');
    retention.touch(commandKey);
    return catalog;
  }
  return {
    async invalidate(agent: AgentKind): Promise<void> {
      revisions[agent] = (revisions[agent] ?? 0) + 1;
      // 保存后在途的旧目录也失效，不能晚于新配置重新填回缓存。
      for (const key of new Set([
        ...cache.keys(),
        ...models.keys(),
        ...refreshing.keys(),
        ...reading.keys(),
        ...commandKeys.keys(),
        ...evictedCommands,
      ])) {
        if ((JSON.parse(key) as string[])[0] !== agent) continue;
        cache.delete(key);
        models.delete(key);
        refreshing.delete(key);
        reading.delete(key);
        retention.delete(key);
        commandKeys.delete(key);
        evictedCommands.delete(key);
        restoring.delete(key);
      }
      await disk?.invalidate(agent);
    },
    read(ws: Workspace, agent: AgentKind): Promise<AgentCapabilities> {
      return readDirectory(ws.dir, agent);
    },
    refresh(ws: Workspace, agent: AgentKind, signal?: AbortSignal): Promise<AgentCapabilities> {
      return refreshDirectory(ws.dir, agent, signal);
    },
    readDirectory,
    refreshDirectory,
    prepare(
      ws: Workspace,
      agent: AgentKind,
      input: { text: string; selection?: CapabilitySelection; sessionId?: string },
      signal?: AbortSignal,
    ): Promise<{ text: string; invocation?: NativeInvocation }> {
      return Promise.resolve().then(async () => {
        const { text, selection, sessionId } = input;
        const command = selection ? undefined : typedCommand(text);
        if (!selection && !command) return { text };
        signal?.throwIfAborted();
        const catalog = await commandCatalog(ws.dir, agent, signal);
        const entry = chooseEntry(catalog.entries, selection, command?.name);
        return prepareEntry(entry, command ? command.text : text, sessionId);
      });
    },
  };
}
export type CapabilitiesService = ReturnType<typeof createCapabilitiesService>;
