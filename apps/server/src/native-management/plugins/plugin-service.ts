import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '@agentdeck/shared/conversation';
import {
  NativePluginPrepareSchema,
  NativePluginStartSchema,
  type NativePluginCatalog,
  type NativePluginOperation,
  type NativePluginPrepareInput,
  type NativePluginStartInput,
} from '@agentdeck/shared/settings';
import { resolveLocalCommand, type ResolvedCommand } from '../../platform/process/executable';
import { runInstallationProcess } from '../../cli-installation/transaction/installation-process';
import type { ProcessRunner } from '../../platform/process/run';
import { resourcePathKey } from '../../agents/common/configuration/resources';
import { NativeResourceError } from '../../agents/common/configuration/errors';
import type { NativeManagementAccess, NativeManagementProject } from '../access';
import { NativeManagementError } from '../errors';
import { pluginDigest, jsonResult, arrayResult } from './plugin-utils';
import { PluginError } from './plugin-errors';
import { codexPluginPolicy, type PluginPolicy } from './plugin-policy';
import { object, type PluginContext, type PluginRecord, type PluginMarketplace } from './plugin-types';
import {
  nativeConfirmation,
  pluginArguments,
  pluginConfiguration,
  validatePreparation,
  writeCodexEnabled,
} from './plugin-native';
type Deps = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  environment?(agent: AgentKind): Promise<NodeJS.ProcessEnv>;
  run?: ProcessRunner;
  command?(agent: AgentKind, env: NodeJS.ProcessEnv): ResolvedCommand;
  access?: NativeManagementAccess;
  onChanged?(agent: AgentKind): void | Promise<void>;
  getProject?(id: string): Promise<NativeManagementProject | undefined>;
  readCodexPolicy?(context: PluginContext): Promise<PluginPolicy>;
};
type Task = {
  view: NativePluginOperation;
  input: NativePluginPrepareInput;
  context: PluginContext;
  project?: NativeManagementProject;
  plugin?: PluginRecord;
  market?: PluginMarketplace;
  catalog: NativePluginCatalog;
  abort: AbortController;
  wake?: (value: string | undefined) => void;
  done?: Promise<void>;
  fingerprint?: string;
  expires: number;
  expiryTimer?: NodeJS.Timeout;
};
const active = (s: NativePluginOperation['status']) => ['running', 'awaiting-confirmation', 'cancelling'].includes(s);
import { readPluginInventory } from './plugin-catalog';
import { verifyPluginResult } from './plugin-verification';
export function createNativePluginService(deps: Deps = {}) {
  const tasks = new Map<string, Task>();
  const homeDir = path.resolve(deps.homeDir ?? os.homedir());
  async function context(agent: AgentKind, project?: NativeManagementProject): Promise<PluginContext> {
    const env = deps.environment ? await deps.environment(agent) : (deps.env ?? process.env);
    const command = deps.command?.(agent, env) ?? resolveLocalCommand(agent === 'antigravity' ? 'agy' : agent, env);
    const c: PluginContext = {
      agent,
      homeDir,
      env,
      project,
      run: (args, options = {}) =>
        (deps.run ?? runInstallationProcess)(command.command, [...command.args, ...args], {
          cwd: project?.dir ?? homeDir,
          env,
          timeoutMs: 15000,
          outputCap: 512 * 1024,
          ...options,
        }),
    };
    if (agent === 'codex') c.readPolicy = () => (deps.readCodexPolicy ?? codexPluginPolicy)(c);
    return c;
  }
  const sameProject = (a: NativeManagementProject | undefined, b: NativeManagementProject | undefined) =>
    a?.id === b?.id && (!a || !b || resourcePathKey(a.dir) === resourcePathKey(b.dir));
  function taskFor(agent: AgentKind, project: NativeManagementProject | undefined, id: string) {
    const task = tasks.get(id);
    if (!task || task.context.agent !== agent || !sameProject(task.project, project))
      throw new PluginError('plugin_operation_missing');
    return task;
  }
  function snapshot(task: Task) {
    return structuredClone(task.view);
  }
  function list(agent: AgentKind, project?: NativeManagementProject) {
    return [...tasks.values()]
      .filter((t) => t.context.agent === agent && sameProject(t.project, project))
      .map(snapshot);
  }
  const inventory = (c: PluginContext) => readPluginInventory(c, list(c.agent, c.project));
  async function currentProject(task: Task) {
    if (task.project && deps.getProject) {
      const current = await deps.getProject(task.project.id);
      if (!current || !sameProject(current, task.project)) throw new NativeResourceError('revision_conflict');
    }
  }
  function targetRevision(input: NativePluginPrepareInput, data: Awaited<ReturnType<typeof inventory>>) {
    return input.id
      ? (data.native.plugins.find((p) => p.entry!.id === input.id)?.entry?.revision ??
          data.native.marketplaces.find((m) => m.entry!.id === input.id)?.entry?.revision)
      : data.catalog.revision;
  }
  function touch(task: Task, status: NativePluginOperation['status'], message?: string) {
    task.view.status = status;
    task.view.updatedAt = new Date().toISOString();
    task.view.message = message;
  }
  async function refresh(task: Task) {
    try {
      task.catalog = (await inventory(task.context)).catalog;
      return true;
    } catch {
      task.view.message = '原生状态暂时无法重读，请稍后刷新核对。';
      return false;
    }
  }
  const confirmed = (task: Task, before: NativePluginCatalog) =>
    verifyPluginResult(
      task.context,
      { input: task.input, plugin: task.plugin, market: task.market, scope: task.view.scope },
      task.catalog,
      before,
    );
  async function execute(task: Task) {
    if (task.context.agent === 'codex' && ['enable', 'disable'].includes(task.input.action)) {
      await writeCodexEnabled(task.plugin!, task.input.action === 'enable');
      return 0;
    }
    let confirmation: string | undefined;
    while (!task.abort.signal.aborted) {
      const result = await task.context.run(
        pluginArguments(task.context, task.input, { plugin: task.plugin, market: task.market, confirmation }),
        {
          signal: task.abort.signal,
          timeoutMs: 120000,
          input: task.input.values ? JSON.stringify(task.input.values) : undefined,
        },
      );
      const shown = task.context.agent === 'claude' ? nativeConfirmation(result.stdout) : undefined;
      if (!shown) return verifyNativeList(task, result.exitCode);
      const waitingRevision = (await inventory(task.context)).catalog.revision;
      if (task.abort.signal.aborted) return null;
      task.view.shownCommand = shown;
      touch(task, 'awaiting-confirmation', '原生要求确认以下确切命令后才能继续。');
      confirmation = await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(
          () => {
            task.abort.abort();
            resolve(undefined);
          },
          10 * 60 * 1000,
        );
        task.wake = (value) => {
          clearTimeout(timer);
          task.wake = undefined;
          resolve(value);
        };
      });
      if (!confirmation) return null;
      if ((await inventory(task.context)).catalog.revision !== waitingRevision)
        throw new NativeResourceError('revision_conflict');
      touch(task, 'running');
    }
    return null;
  }
  async function verifyNativeList(task: Task, code: number | null) {
    if (code !== 0 || task.context.agent !== 'codex' || task.input.action !== 'marketplace-refresh') return code;
    const result = await task.context.run(['plugin', 'list', '--marketplace', task.market!.name, '--json'], {
      signal: task.abort.signal,
      timeoutMs: 120000,
    });
    if (result.exitCode === 0) arrayResult(object(jsonResult(result.stdout)).installed);
    return result.exitCode;
  }
  async function preflight(task: Task) {
    await currentProject(task);
    const data = await inventory(task.context);
    if (targetRevision(task.input, data) !== task.input.revision) throw new NativeResourceError('revision_conflict');
    task.plugin = data.native.plugins.find((p) => p.entry!.id === task.input.id);
    task.market = data.native.marketplaces.find((m) => m.entry!.id === task.input.id);
    await validatePreparation(task.context, task.input, task.plugin, task.market);
  }
  async function finish(task: Task, code: number | null, before: NativePluginCatalog) {
    const reread = await refresh(task),
      verified = code === 0 && reread && (await confirmed(task, before));
    if (task.abort.signal.aborted) {
      touch(task, 'cancelled', '已停止原生进程；可能留下部分结果，请核对列表。');
      return;
    }
    touch(
      task,
      verified ? 'succeeded' : 'unknown',
      verified
        ? '原生操作已完成并重新读取状态；请核对启用与配置状态。'
        : '原生可能已部分修改，已重新读取状态，请勿重复安装。',
    );
  }
  async function runTask(task: Task, ready: (error?: unknown) => void) {
    let started = false;
    let outcome: Pick<NativePluginOperation, 'status' | 'message'> | undefined;
    const operation = async () => {
      try {
        await preflight(task);
        if (task.abort.signal.aborted) {
          touch(task, 'cancelled');
          ready();
          return;
        }
        started = true;
        ready();
        const before = task.catalog;
        await finish(task, await execute(task), before);
      } catch (error) {
        ready(error);
        await refresh(task);
        taskFailure(task, started);
      } finally {
        outcome = { status: task.view.status, message: task.view.message };
        touch(task, task.abort.signal.aborted ? 'cancelling' : 'running');
        if (started) await deps.onChanged?.(task.context.agent);
      }
    };
    try {
      await (deps.access ? deps.access.write(task.context.agent, task.project, operation) : operation());
      if (outcome) touch(task, task.abort.signal.aborted ? 'cancelled' : outcome.status, outcome.message);
    } catch (error) {
      ready(error);
      taskFailure(task, started);
    } finally {
      task.input.values = undefined;
      task.wake = undefined;
    }
  }
  function taskFailure(task: Task, started: boolean) {
    const status = started ? 'unknown' : 'failed';
    touch(
      task,
      task.abort.signal.aborted ? 'cancelled' : status,
      started
        ? '操作结果未确认，请核对重新读取的原生状态；请勿重复安装。'
        : '操作未开始，请检查原生来源、版本或 CLI 忙碌状态。',
    );
  }
  function prune() {
    for (const [id, t] of tasks)
      if (!active(t.view.status) && t.expires < Date.now()) {
        clearTimeout(t.expiryTimer);
        tasks.delete(id);
      }
    if (tasks.size >= 100) throw new PluginError('plugin_capacity');
  }
  async function prepareTask(c: PluginContext, input: NativePluginPrepareInput) {
    const data = await inventory(c);
    if (targetRevision(input, data) !== input.revision) throw new NativeResourceError('revision_conflict');
    const plugin = data.native.plugins.find((p) => p.entry!.id === input.id),
      market = data.native.marketplaces.find((m) => m.entry!.id === input.id);
    if (input.action === 'install' && !data.catalog.installScopes.length)
      throw new NativeManagementError('unsupported_action');
    if (input.action === 'marketplace-add' && !data.catalog.canAddMarketplace)
      throw new NativeManagementError('unsupported_action');
    await validatePreparation(c, input, plugin, market);
    const now = new Date().toISOString(),
      operationId = randomUUID();
    const descriptor = describe(input, plugin, market);
    const view: NativePluginOperation = {
      operationId,
      revision: pluginDigest([operationId, input.action, input.revision]),
      agent: c.agent,
      projectId: c.project?.id,
      action: input.action,
      ...descriptor,
      impact: impact(input.action),
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
    };
    const task: Task = {
      view,
      input: structuredClone(input),
      context: c,
      project: c.project,
      plugin,
      market,
      catalog: data.catalog,
      abort: new AbortController(),
      expires: Date.now() + 24 * 60 * 60 * 1000,
    };
    task.expiryTimer = setTimeout(
      () => {
        if (task.view.status === 'prepared') expirePreview(task);
      },
      15 * 60 * 1000,
    );
    task.expiryTimer.unref();
    tasks.set(operationId, task);
    return snapshot(task);
  }
  function expirePreview(task: Task) {
    clearTimeout(task.expiryTimer);
    task.input.values = undefined;
    touch(task, 'failed', '操作预览已过期，请重新准备。');
  }
  function resume(task: Task, input: NativePluginStartInput) {
    if (!input.confirmation) return snapshot(task);
    if (input.confirmation !== task.view.shownCommand?.sha256) throw new PluginError('plugin_confirmation');
    task.fingerprint = input.confirmation;
    touch(task, 'running');
    task.wake?.(input.confirmation);
    return snapshot(task);
  }
  function launch(task: Task, input: NativePluginStartInput) {
    if (input.confirmation) throw new PluginError('plugin_confirmation');
    if (Date.now() - Date.parse(task.view.createdAt) > 15 * 60 * 1000) {
      expirePreview(task);
      throw new PluginError('plugin_expired');
    }
    clearTimeout(task.expiryTimer);
    touch(task, 'running');
    return new Promise<void>((resolve, reject) => {
      let sent = false;
      task.done = runTask(task, (error) => {
        if (sent) return;
        sent = true;
        if (error) reject(error instanceof Error ? error : new NativeManagementError('native_unavailable'));
        else resolve();
      });
    });
  }
  return {
    async read(agent: AgentKind, project?: NativeManagementProject): Promise<NativePluginCatalog> {
      const running = [...tasks.values()].find(
        (t) => t.context.agent === agent && sameProject(t.project, project) && active(t.view.status),
      );
      if (running)
        return {
          ...structuredClone(running.catalog),
          operations: list(agent, project),
          warnings: [...running.catalog.warnings, '插件操作进行中，当前展示开始前的目录；完成后重新读取。'],
        };
      const run = async () => {
        const c = await context(agent, project);
        return (await inventory(c)).catalog;
      };
      return deps.access ? deps.access.read(agent, run) : run();
    },
    async detail(agent: AgentKind, id: string, revision: string, project?: NativeManagementProject) {
      const run = async () => {
        const c = await context(agent, project),
          data = await inventory(c),
          p = data.native.plugins.find((p) => p.entry!.id === id);
        if (!p || p.entry!.revision !== revision) throw new NativeResourceError('revision_conflict');
        const config = p.actions.includes('configure')
          ? await pluginConfiguration(c, p)
          : { options: [], configurationRevision: undefined };
        return { entry: p.entry!, ...config };
      };
      return deps.access ? deps.access.read(agent, run) : run();
    },
    async prepare(agent: AgentKind, input: NativePluginPrepareInput, project?: NativeManagementProject) {
      if (!NativePluginPrepareSchema.safeParse(input).success) throw new NativeResourceError('invalid_request');
      const run = async () => {
        prune();
        return prepareTask(await context(agent, project), input);
      };
      return deps.access ? deps.access.read(agent, run) : run();
    },
    async start(agent: AgentKind, input: NativePluginStartInput, project?: NativeManagementProject) {
      if (!NativePluginStartSchema.safeParse(input).success) throw new NativeResourceError('invalid_request');
      const task = taskFor(agent, project, input.operationId);
      if (task.view.revision !== input.revision) throw new NativeResourceError('revision_conflict');
      if (task.view.status === 'awaiting-confirmation') return resume(task, input);
      if (task.view.status !== 'prepared') {
        if (input.confirmation && task.fingerprint !== input.confirmation) throw new PluginError('plugin_confirmation');
        return snapshot(task);
      }
      await launch(task, input);
      return snapshot(task);
    },
    operation(agent: AgentKind, project: NativeManagementProject | undefined, id: string) {
      return snapshot(taskFor(agent, project, id));
    },
    cancel(agent: AgentKind, project: NativeManagementProject | undefined, id: string) {
      const task = taskFor(agent, project, id);
      if (task.view.status === 'prepared') {
        clearTimeout(task.expiryTimer);
        task.input.values = undefined;
        touch(task, 'cancelled');
      } else if (active(task.view.status)) {
        touch(task, 'cancelling');
        task.abort.abort();
        task.wake?.(undefined);
      }
      return snapshot(task);
    },
    async dispose() {
      for (const task of tasks.values()) {
        clearTimeout(task.expiryTimer);
        task.abort.abort();
        task.wake?.(undefined);
        task.input.values = undefined;
      }
      await Promise.allSettled([...tasks.values()].flatMap((t) => (t.done ? [t.done] : [])));
    },
  };
}
export type NativePluginService = ReturnType<typeof createNativePluginService>;

function describe(input: NativePluginPrepareInput, plugin?: PluginRecord, market?: PluginMarketplace) {
  if (plugin) return { target: plugin.selector, source: plugin.source, scope: plugin.scope };
  if (market) return { target: market.name, source: market.source, scope: market.scope };
  return { target: input.source!, source: input.source!, scope: input.scope ?? 'user' };
}
function impact(action: NativePluginPrepareInput['action']) {
  const text: Partial<Record<typeof action, string>> = {
    uninstall: '移除此范围的原生插件；Claude 保留插件数据。',
    configure: '保存此原生插件的配置值；未填写项保留。',
    'marketplace-refresh': '仅刷新指定市场来源，可能访问网络，不等同于插件更新。',
  };
  return text[action] ?? '修改所选原生插件或市场，可能执行安装过程；下一次实例启动读取。';
}
