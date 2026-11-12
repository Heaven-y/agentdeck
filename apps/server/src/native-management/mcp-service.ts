import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentKind } from '@agentdeck/shared/conversation';
import {
  NativeMcpSaveSchema,
  NativeMcpOperateSchema,
  type NativeMcpCatalog,
  type NativeMcpEntry,
  type NativeMcpSaveInput,
  type NativeMcpOperateInput,
} from '@agentdeck/shared/settings';
import { claudeMcpSources } from '../agents/claude/configuration/mcp';
import { codexMcpSources } from '../agents/codex/configuration/mcp';
import { antigravityMcpSources } from '../agents/antigravity/configuration/mcp';
import { resourcePathKey } from '../agents/common/configuration/resources';
import { NativeResourceError } from '../agents/common/configuration/errors';
import { encodeJson } from '../agents/common/configuration/patch';
import { nativeFileTransaction } from '../platform/files/transactions';
import {
  inspectDirectory,
  assertDirectoryUnchanged,
  readConfigFile,
  writeConfigFile,
} from '../platform/files/safe-file';
import { resolveLocalCommand } from '../platform/process/executable';
import { runProcess, type ProcessRunner } from '../platform/process/run';
import type { NativeManagementAccess, NativeManagementProject } from './types';
import { object, serverMap, type McpContext, type McpSource, type McpPlugin } from './mcp-types';
import { managementError, NativeManagementError } from './errors';
import { mcpTransport, publicMcpConfig, mergeMcpConfig, safeClaudeArguments, sameClaudeEntry } from './mcp-config';
import { editMcpToml, patchMcpToml } from './mcp-toml';
import { readMcpPlugins } from './mcp-plugins';

type Deps = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  environment?(agent: AgentKind): Promise<NodeJS.ProcessEnv>;
  access?: NativeManagementAccess;
  onChanged?(agent: AgentKind): void | Promise<void>;
  run?: ProcessRunner;
  plugins?(context: McpContext): Promise<McpPlugin[]>;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceId = (context: McpContext, source: McpSource) =>
  digest([context.agent, resourcePathKey(source.file), source.scope, source.key]);
const sourceRevision = (context: McpContext, source: McpSource) => digest([sourceId(context, source), source.revision]);
function configuredEnabled(agent: AgentKind, config: Record<string, unknown>): boolean | null {
  if (agent === 'claude') return null;
  return agent === 'codex' ? config.enabled !== false : config.disabled !== true;
}
function entry(context: McpContext, source: McpSource, name: string, config: Record<string, unknown>): NativeMcpEntry {
  const id = sourceId(context, source),
    transport = mcpTransport(context.agent, config);
  const writable = !source.readOnly && (!source.commandScope || /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name));
  const editable = writable && transport !== 'unknown' && (!source.commandScope || safeClaudeArguments(config));
  return {
    id: digest([id, name]),
    sourceId: id,
    revision: sourceRevision(context, source),
    name,
    scope: source.scope,
    source: source.label,
    transport,
    enabled: configuredEnabled(context.agent, config),
    runtime: 'unchecked',
    config: publicMcpConfig(context.agent, config),
    actions: {
      edit: editable,
      delete: writable,
      enable: writable && context.agent !== 'claude',
      disable: writable && context.agent !== 'claude',
    },
    ...(!editable
      ? {
          reason: source.commandScope
            ? '用户/个人项目配置通过原生命令维护；含地址、参数或凭据的配置请使用原生入口，避免秘密进入命令参数。'
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
    transport: mcpTransport(context.agent, plugin.config),
    enabled: null,
    runtime: 'unchecked',
    config: publicMcpConfig(context.agent, plugin.config),
    actions: { edit: false, delete: false, enable: false, disable: false },
    reason: '请从所属原生插件管理。',
  };
}
export function createNativeMcpService(deps: Deps = {}) {
  const homeDir = path.resolve(deps.homeDir ?? os.homedir());
  async function context(agent: AgentKind, project?: NativeManagementProject): Promise<McpContext> {
    if (!['claude', 'codex', 'antigravity'].includes(agent)) throw new NativeResourceError('invalid_agent');
    return {
      agent,
      project,
      homeDir,
      env: deps.environment ? await deps.environment(agent) : (deps.env ?? process.env),
    };
  }
  const sourcesFor = (c: McpContext) =>
    c.agent === 'claude' ? claudeMcpSources(c) : c.agent === 'codex' ? codexMcpSources(c) : antigravityMcpSources(c);
  async function inventory(c: McpContext) {
    const sources = await sourcesFor(c);
    const entries = sources.flatMap((s) =>
      Object.entries(serverMap(s)).map(([name, config]) => entry(c, s, name, object(config))),
    );
    return { sources, entries };
  }
  async function write<T>(agent: AgentKind, project: NativeManagementProject | undefined, operation: () => Promise<T>) {
    const run = async () => {
      try {
        return await operation();
      } catch (error) {
        throw managementError(error);
      } finally {
        await deps.onChanged?.(agent);
      }
    };
    return deps.access ? deps.access.write(agent, project, run) : run();
  }
  async function mutate(c: McpContext, source: McpSource, name: string, value: Record<string, unknown> | undefined) {
    return nativeFileTransaction(source.file, async () => {
      const parents = await inspectDirectory(path.dirname(source.file), true);
      const previous = await readConfigFile(source.file);
      if (previous.revision !== source.revision) throw new NativeResourceError('revision_conflict');
      if (source.commandScope) return writeClaude(c, source, { name, value, parents: parents! });
      const before = object(serverMap(source)[name]);
      let content: string;
      if (c.agent === 'codex')
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
  async function writeClaude(
    c: McpContext,
    source: McpSource,
    target: {
      name: string;
      value: Record<string, unknown> | undefined;
      parents: NonNullable<Awaited<ReturnType<typeof inspectDirectory>>>;
    },
  ) {
    const { name, value, parents } = target;
    if (value && !safeClaudeArguments(value)) throw new NativeManagementError('unsupported_action');
    const cli = resolveLocalCommand('claude', c.env);
    const run = async (args: string[]) => {
      const result = await (deps.run ?? runProcess)(
        cli.command,
        [...cli.args, 'mcp', ...args, '--scope', source.commandScope!],
        { cwd: c.project?.dir ?? homeDir, env: c.env, timeoutMs: 15000, outputCap: 64 * 1024 },
      );
      if (result.exitCode !== 0) throw new NativeManagementError('result_unconfirmed');
    };
    if (Object.hasOwn(serverMap(source), name)) await run(['remove', name]);
    if (value) await run(['add-json', name, JSON.stringify(value)]);
    await assertDirectoryUnchanged(parents);
    const after = (await sourcesFor(c)).find((s) => sourceId(c, s) === sourceId(c, source))!;
    if (!sameClaudeEntry(serverMap(after)[name], value)) throw new NativeManagementError('result_unconfirmed');
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
        const warnings = ['列表仅表示配置；原生信任、策略和同名来源覆盖在运行时决定。'];
        try {
          entries.push(...(await (deps.plugins ?? readMcpPlugins)(c)).map((p) => pluginEntry(c, p)));
        } catch {
          warnings.push('插件 MCP 来源暂时无法核实，请从原生插件入口查看。');
        }
        if (agent === 'antigravity')
          warnings.push('此版本没有可靠的独立运行状态或无头 OAuth 接口；请在原生 MCP 面板检查连接与授权。');
        if (agent === 'codex')
          warnings.push('离线列表读取原生配置及已核实安装缓存；插件内的 MCP 由所属插件管理，不自动访问市场。');
        return {
          agent,
          entries,
          sources: sources
            .map((s) => ({
              id: sourceId(c, s),
              revision: sourceRevision(c, s),
              scope: s.scope,
              label: s.label,
              writable: !s.readOnly,
              secretInput: !s.commandScope,
              transports: s.commandScope
                ? (['stdio'] as const)
                : agent === 'claude'
                  ? (['stdio', 'http', 'sse'] as const)
                  : (['stdio', 'http'] as const),
            }))
            .map((s) => ({ ...s, transports: [...s.transports] })),
          warnings,
        };
      };
      try {
        return await (deps.access ? deps.access.read(agent, run) : run());
      } catch (error) {
        throw managementError(error);
      }
    },
    async saveMcp(agent: AgentKind, input: NativeMcpSaveInput, project?: NativeManagementProject) {
      if (
        !NativeMcpSaveSchema.safeParse(input).success ||
        ['__proto__', 'constructor', 'prototype'].includes(input.name)
      )
        throw new NativeResourceError('invalid_request');
      return write(agent, project, async () => {
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
        await mutate(c, source, input.name, mergeMcpConfig(agent, object(serverMap(source)[input.name]), input.config));
        return { status: 'saved' as const, nextTurn: true as const };
      });
    },
    async operateMcp(agent: AgentKind, input: NativeMcpOperateInput, project?: NativeManagementProject) {
      if (!NativeMcpOperateSchema.safeParse(input).success) throw new NativeResourceError('invalid_request');
      return write(agent, project, async () => {
        const c = await context(agent, project),
          { sources, entries } = await inventory(c);
        const found = entries.find((e) => e.id === input.id);
        if (!found || !found.actions[input.action]) throw new NativeManagementError('unsupported_action');
        if (found.revision !== input.revision) throw new NativeResourceError('revision_conflict');
        const source = sources.find((s) => sourceId(c, s) === found.sourceId)!;
        const value = { ...object(serverMap(source)[found.name]) };
        if (input.action !== 'delete')
          value[agent === 'codex' ? 'enabled' : 'disabled'] =
            agent === 'codex' ? input.action === 'enable' : input.action === 'disable';
        await mutate(c, source, found.name, input.action === 'delete' ? undefined : value);
        return {
          status: input.action === 'delete' ? ('deleted' as const) : ('saved' as const),
          nextTurn: true as const,
        };
      });
    },
  };
}
export type NativeMcpService = ReturnType<typeof createNativeMcpService>;
