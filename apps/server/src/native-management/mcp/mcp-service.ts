import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isAgentKind, type AgentKind } from '@agentdeck/shared/conversation';
import {
  NativeMcpSaveSchema,
  NativeMcpOperateSchema,
  type NativeMcpCatalog,
  type NativeMcpEntry,
  type NativeMcpSaveInput,
  type NativeMcpOperateInput,
} from '@agentdeck/shared/settings';
import { claudeMcp } from '../../agents/claude/configuration/mcp';
import { codexMcp } from '../../agents/codex/configuration/mcp';
import { antigravityMcp } from '../../agents/antigravity/configuration/mcp';
import { resourcePathKey } from '../../agents/common/configuration/resources';
import { NativeResourceError } from '../../agents/common/configuration/errors';
import { encodeJson } from '../../agents/common/configuration/patch';
import { nativeFileTransaction } from '../../platform/files/transactions';
import { inspectDirectory, readConfigFile, writeConfigFile } from '../../platform/files/safe-file';
import { canSaveClaudeMcp, writeClaudeMcp } from '../../agents/claude/configuration/mcp-command';
import type { ProcessRunner } from '../../platform/process/run';
import type { NativeManagementAccess, NativeManagementProject } from '../access';
import { object, serverMap, type McpAdapter, type McpContext, type McpSource, type McpPlugin } from './mcp-types';
import { managementError, NativeManagementError } from '../errors';
import {
  mcpTransport,
  publicMcpConfig,
  mergeMcpConfig,
  configuredEnabled,
  setConfiguredEnabled,
  sourceTransports,
} from './mcp-config';
import { editMcpToml, patchMcpToml } from './mcp-toml';
import { readMcpPlugins } from './mcp-plugins';
import type { SessionToolsCommand } from '../../settings/session-tools/command';
import {
  ownsSessionToolsEntry,
  SESSION_TOOLS_NAME,
  sessionToolsEntryForAgent,
} from '../../settings/session-tools/session-tools-format';

export type McpWriteProject = NativeManagementProject & {
  reload(): Promise<NativeManagementProject | undefined>;
};

async function reloadWriteProject(target?: McpWriteProject): Promise<NativeManagementProject | undefined> {
  if (!target) return undefined;
  const current = await target.reload();
  if (!current || current.id !== target.id) throw new NativeResourceError('project_missing');
  if (resourcePathKey(current.dir) !== resourcePathKey(target.dir)) throw new NativeResourceError('revision_conflict');
  return current;
}

type Deps = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  environment?(agent: AgentKind): Promise<NodeJS.ProcessEnv>;
  access?: NativeManagementAccess;
  onChanged?(agent: AgentKind): void | Promise<void>;
  run?: ProcessRunner;
  plugins?(context: McpContext): Promise<McpPlugin[]>;
  sessionToolsCommand?: SessionToolsCommand;
};
const adapters = {
  claude: claudeMcp,
  codex: codexMcp,
  antigravity: antigravityMcp,
} satisfies Record<AgentKind, McpAdapter>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceId = (context: McpContext, source: McpSource) =>
  digest([context.agent, resourcePathKey(source.file), source.scope, source.key]);
const sourceRevision = (context: McpContext, source: McpSource) => digest([sourceId(context, source), source.revision]);
function entry(context: McpContext, source: McpSource, name: string, config: Record<string, unknown>): NativeMcpEntry {
  const adapter = adapters[context.agent];
  const id = sourceId(context, source);
  const transport = mcpTransport(adapter, config);
  const enabled = transport === 'unknown' ? null : configuredEnabled(adapter, config);
  const writable = !source.readOnly && (!source.commandScope || /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(name));
  const editable = writable && transport !== 'unknown' && (!source.commandScope || canSaveClaudeMcp(name, config));
  const canToggle = writable && enabled !== null;
  return {
    id: digest([id, name]),
    sourceId: id,
    revision: sourceRevision(context, source),
    name,
    scope: source.scope,
    source: source.label,
    transport,
    enabled,
    runtime: 'unchecked',
    config: publicMcpConfig(adapter, config),
    actions: {
      edit: editable,
      delete: writable,
      enable: canToggle,
      disable: canToggle,
    },
    ...(!editable
      ? {
          reason: source.commandScope
            ? '用户/个人项目只通过原生命令维护名称受支持且不含地址、参数或凭据的 stdio 配置。'
            : '此来源仅可从原生或所属插件入口管理。',
        }
      : {}),
  };
}
function pluginEntry(context: McpContext, plugin: McpPlugin): NativeMcpEntry {
  const sourceId = digest([
    context.agent,
    'plugin',
    plugin.owner,
    plugin.nativeScope ?? plugin.scope ?? 'directory',
    resourcePathKey(plugin.installationRoot),
  ]);
  return {
    id: digest([sourceId, plugin.name]),
    sourceId,
    revision: digest([sourceId, plugin.name, plugin.config]),
    name: plugin.name,
    scope: plugin.scope ?? 'directory',
    source: '原生插件',
    owner: plugin.owner,
    transport: mcpTransport(adapters[context.agent], plugin.config),
    enabled: null,
    runtime: 'unchecked',
    config: publicMcpConfig(adapters[context.agent], plugin.config),
    actions: { edit: false, delete: false, enable: false, disable: false },
    reason: '请从所属原生插件管理。',
  };
}
export function createNativeMcpService(deps: Deps = {}) {
  const homeDir = path.resolve(deps.homeDir ?? os.homedir());
  async function context(agent: AgentKind, project?: NativeManagementProject): Promise<McpContext> {
    if (!isAgentKind(agent)) throw new NativeResourceError('invalid_agent');
    return {
      agent,
      project,
      homeDir,
      env: deps.environment ? await deps.environment(agent) : (deps.env ?? process.env),
    };
  }
  async function inventory(c: McpContext) {
    const sources = await adapters[c.agent].sources(c);
    const entries = sources.flatMap((s) =>
      Object.entries(serverMap(s)).map(([name, config]) => {
        const item = entry(c, s, name, object(config));
        if (
          s.scope === 'user' &&
          name === SESSION_TOOLS_NAME &&
          deps.sessionToolsCommand &&
          ownsSessionToolsEntry(config, sessionToolsEntryForAgent(c.agent, deps.sessionToolsCommand))
        ) {
          item.managedBy = 'session-tools';
          item.actions = { edit: false, delete: false, enable: false, disable: false };
          item.reason = '请使用会话引用开关管理。';
        }
        return item;
      }),
    );
    return { sources, entries };
  }
  async function write<T>(
    agent: AgentKind,
    target: McpWriteProject | undefined,
    operation: (project?: NativeManagementProject) => Promise<T>,
  ) {
    const run = async () => {
      // 取得项目写租约后再核对目录，失败时不进入配置读写或缓存失效。
      const project = await reloadWriteProject(target);
      const outcome = await operation(project).then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
      try {
        await deps.onChanged?.(agent);
      } catch {
        // 配置可能已落盘，不能把重启失败当作保存前的错误。
        if (outcome.ok) throw new NativeManagementError('mcp_change_unconfirmed');
      }
      if (!outcome.ok) throw managementError(outcome.error);
      return outcome.value;
    };
    return deps.access ? deps.access.write(agent, target, run) : run();
  }
  async function mutate(c: McpContext, source: McpSource, name: string, value: Record<string, unknown> | undefined) {
    return nativeFileTransaction(source.file, async () => {
      if (source.commandScope) return writeClaudeMcp(c, source, { name, value }, deps.run);
      const parents = await inspectDirectory(path.dirname(source.file), true);
      const previous = await readConfigFile(source.file);
      if (previous.revision !== source.revision) throw new NativeResourceError('revision_conflict');
      const before = object(serverMap(source)[name]);
      let content: string;
      if (adapters[c.agent].format === 'toml')
        content =
          value === undefined
            ? editMcpToml(source.content, [...source.key, name], undefined)
            : patchMcpToml(source.content, [...source.key, name], before, value);
      else {
        const data = structuredClone(source.data);
        let target = data;
        for (const part of source.key) {
          if (!Object.hasOwn(target, part)) target[part] = {};
          target = object(target[part]);
        }
        if (value === undefined) delete target[name];
        else Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
        content = encodeJson(source.content, data);
      }
      if (Buffer.byteLength(content) > 256 * 1024) throw new NativeResourceError('too_large');
      await writeConfigFile(source.file, Buffer.from(content), previous, parents!);
    });
  }
  return {
    async resolveMcp(agent: AgentKind, id: string, revision: string, project?: NativeManagementProject) {
      const c = await context(agent, project),
        { sources, entries } = await inventory(c);
      const found = entries.find((e) => e.id === id);
      if (!found) throw new NativeManagementError('unsupported_action');
      if (found.revision !== revision) throw new NativeResourceError('revision_conflict');
      const source = sources.find((s) => sourceId(c, s) === found.sourceId)!;
      return {
        context: c,
        entry: found,
        config: object(serverMap(source)[found.name]),
        ambiguous: entries.filter((e) => e.name === found.name).length > 1,
      };
    },
    async readMcp(agent: AgentKind, project?: NativeManagementProject): Promise<NativeMcpCatalog> {
      const run = async () => {
        const c = await context(agent, project),
          { sources, entries } = await inventory(c);
        const warnings: string[] = [];
        try {
          entries.push(...(await (deps.plugins ?? readMcpPlugins)(c)).map((p) => pluginEntry(c, p)));
        } catch {
          warnings.push('未能读取插件中的 MCP，请在插件管理中查看。');
        }
        const adapter = adapters[agent];
        return {
          agent,
          entries,
          sources: sources.map((s) => ({
            id: sourceId(c, s),
            revision: sourceRevision(c, s),
            scope: s.scope,
            label: s.label,
            writable: !s.readOnly,
            secretInput: !s.commandScope,
            transports: [...sourceTransports(adapter, s)],
          })),
          warnings,
        };
      };
      try {
        return await (deps.access ? deps.access.read(agent, run) : run());
      } catch (error) {
        throw managementError(error);
      }
    },
    async saveMcp(agent: AgentKind, input: NativeMcpSaveInput, target?: McpWriteProject) {
      if (
        !NativeMcpSaveSchema.safeParse(input).success ||
        ['__proto__', 'constructor', 'prototype'].includes(input.name)
      )
        throw new NativeResourceError('invalid_request');
      return write(agent, target, async (project) => {
        const c = await context(agent, project),
          { sources, entries } = await inventory(c);
        const source = sources.find((s) => sourceId(c, s) === input.sourceId);
        if (!source || source.readOnly) throw new NativeManagementError('unsupported_action');
        if (sourceRevision(c, source) !== input.revision) throw new NativeResourceError('revision_conflict');
        const found = entries.find((e) => e.id === input.id);
        if (
          input.id
            ? !found || found.sourceId !== input.sourceId || found.name !== input.name || !found.actions.edit
            : Object.hasOwn(serverMap(source), input.name)
        )
          throw new NativeManagementError('unsupported_action');
        await mutate(
          c,
          source,
          input.name,
          mergeMcpConfig(adapters[agent], source, object(serverMap(source)[input.name]), input.config),
        );
        return { status: 'saved' as const, nextTurn: true as const };
      });
    },
    async operateMcp(agent: AgentKind, input: NativeMcpOperateInput, target?: McpWriteProject) {
      if (!NativeMcpOperateSchema.safeParse(input).success) throw new NativeResourceError('invalid_request');
      return write(agent, target, async (project) => {
        const c = await context(agent, project),
          { sources, entries } = await inventory(c);
        const found = entries.find((e) => e.id === input.id);
        if (!found || !found.actions[input.action]) throw new NativeManagementError('unsupported_action');
        if (found.revision !== input.revision) throw new NativeResourceError('revision_conflict');
        const source = sources.find((s) => sourceId(c, s) === found.sourceId)!;
        const value =
          input.action === 'delete'
            ? undefined
            : setConfiguredEnabled(adapters[agent], object(serverMap(source)[found.name]), input.action === 'enable');
        await mutate(c, source, found.name, value);
        return {
          status: input.action === 'delete' ? ('deleted' as const) : ('saved' as const),
          nextTurn: true as const,
        };
      });
    },
  };
}
export type NativeMcpService = ReturnType<typeof createNativeMcpService>;
