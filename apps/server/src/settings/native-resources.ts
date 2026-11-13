import type { AgentKind } from '@agentdeck/shared/conversation';
import type {
  ClaudeAutoMemoryState,
  NativeResourceCatalog,
  NativeResourceCreateInput,
  NativeResourceDocument,
  NativeResourceSaved,
  NativeResourceSaveInput,
} from '@agentdeck/shared/settings';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { NativeResourceError, resourceError } from '../agents/common/configuration/errors';
import {
  makeResourceTarget,
  userBase,
  type ResourceTarget,
} from '../agents/common/configuration/resources';
import {
  assertDirectoryUnchanged,
  contentRevision,
  decodeUtf8,
  inspectDirectory,
  MAX_CONFIG_BYTES,
  readConfigFile,
  writeConfigFile,
} from '../platform/files/safe-file';
import { nativeFileTransaction } from '../platform/files/transactions';
import { describeResource, describeRoot, discoverResources } from './native-resources-discovery';
import { resourcePlan } from './resource-plan';
import { protectClaudePluginResource } from '../agents/claude/configuration/ownership';

export type NativeResourceProject = { id: string; dir: string };
/** 已取得用户配置写租约的窄写入口，避免复合模型事务再次取得维护锁。 */
export type NativeUserConfigWriter = { save(id: string, input: NativeResourceSaveInput): Promise<NativeResourceSaved> };
type Deps = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  onSaved?: (agent: AgentKind) => void | Promise<void>;
  withWrite?: <T>(
    agent: AgentKind,
    project: NativeResourceProject | undefined,
    operation: () => Promise<T>,
  ) => Promise<T>;
};

function validateContent(target: ResourceTarget, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  if (data.length > MAX_CONFIG_BYTES) throw new NativeResourceError('too_large');
  if (decodeUtf8(data) !== content) throw new NativeResourceError('invalid_utf8');
  const text = content.replace(/^\uFEFF/, '');
  try {
    if (target.format === 'toml') parseToml(text);
    if (target.format === 'json') {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    }
  } catch {
    throw new NativeResourceError(target.format === 'toml' ? 'invalid_toml' : 'invalid_json');
  }
  return data;
}

function simpleName(name: string): string {
  // Windows 保留名、路径分隔、ADS、尾随点/空格在所有平台统一拒绝。
  if (
    !name ||
    name.length > 100 ||
    /[<>:"/\\|?*]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(name) ||
    name === '.' ||
    name === '..'
  )
    throw new NativeResourceError('invalid_request');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new NativeResourceError('invalid_request');
  if (Buffer.from(name, 'utf8').toString('utf8') !== name) throw new NativeResourceError('invalid_request');
  return name;
}

export function createNativeResourcesService(deps: Deps = {}) {
  const homeDir = path.resolve(deps.homeDir ?? os.homedir());
  const env = deps.env ?? process.env;
  function context(agent: AgentKind, project?: NativeResourceProject) {
    if (!['claude', 'codex', 'antigravity'].includes(agent)) throw new NativeResourceError('invalid_agent');
    return { agent, homeDir, env, project };
  }
  async function catalog(agent: AgentKind, project?: NativeResourceProject) {
    const current = context(agent, project);
    const plan = resourcePlan(current);
    const discovered = await discoverResources(current, plan);
    return { plan, ...discovered };
  }
  async function target(agent: AgentKind, id: string, project?: NativeResourceProject) {
    const { targets } = await catalog(agent, project);
    const resource = targets.find((entry) => entry.id === id);
    if (!resource) throw new NativeResourceError('resource_missing');
    return resource;
  }
  function transaction<T>(file: string, action: () => Promise<T>): Promise<T> {
    return nativeFileTransaction(file, action).catch((error: unknown) => {
      throw resourceError(error);
    });
  }
  function claudeSettingsTarget(): ResourceTarget {
    return makeResourceTarget(
      'claude',
      userBase({ agent: 'claude', homeDir, env }, '.claude', env.CLAUDE_CONFIG_DIR),
      'settings.json',
      { kind: 'settings', description: 'Claude 用户原生设置。' },
    );
  }
  function parseClaudeSettings(content: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(content.replace(/^\uFEFF/, '') || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      const settings = parsed as Record<string, unknown>;
      if (Object.hasOwn(settings, 'autoMemoryEnabled') && typeof settings.autoMemoryEnabled !== 'boolean')
        throw new Error();
      return settings;
    } catch {
      throw new NativeResourceError('invalid_json');
    }
  }
  async function readClaudeSettings(resource: ResourceTarget): Promise<Record<string, unknown>> {
    return transaction(resource.file, async () => {
      const parents = await inspectDirectory(path.dirname(resource.file));
      if (!parents) return {};
      const snapshot = await readConfigFile(resource.file);
      await assertDirectoryUnchanged(parents);
      return parseClaudeSettings(snapshot.content);
    });
  }
  async function readAutoMemory(): Promise<ClaudeAutoMemoryState> {
    const settings = await readClaudeSettings(claudeSettingsTarget());
    const override = typeof settings.autoMemoryEnabled === 'boolean' ? settings.autoMemoryEnabled : null;
    return { enabled: override ?? true, override };
  }
  function nextAutoMemoryContent(previous: string, override: boolean | null): string | undefined {
    const settings = parseClaudeSettings(previous);
    const current = typeof settings.autoMemoryEnabled === 'boolean' ? settings.autoMemoryEnabled : null;
    if (current === override) return undefined;
    if (override === null) delete settings.autoMemoryEnabled;
    else settings.autoMemoryEnabled = override;
    const indentation = previous.match(/\r?\n([\t ]+)"[^"]+"\s*:/)?.[1] ?? '  ';
    const eol = previous.includes('\r\n') ? '\r\n' : '\n';
    let content = JSON.stringify(settings, null, indentation).replace(/\n/g, eol);
    if (previous.startsWith('\uFEFF')) content = `\uFEFF${content}`;
    if (!previous || /\r?\n$/.test(previous)) content += eol;
    return content;
  }
  async function writeAutoMemory(resource: ResourceTarget, override: boolean | null): Promise<boolean> {
    let changed = false;
    await transaction(resource.file, async () => {
      const directory = path.dirname(resource.file);
      const beforeDirectories = await inspectDirectory(directory);
      const previous = await readConfigFile(resource.file);
      if (beforeDirectories) await assertDirectoryUnchanged(beforeDirectories);
      const content = nextAutoMemoryContent(previous.content, override);
      if (content === undefined) return;
      const data = validateContent(resource, content);
      const directories = await inspectDirectory(directory, true);
      await writeConfigFile(resource.file, data, previous, directories!);
      changed = true;
    });
    return changed;
  }
  async function setAutoMemory(override: boolean | null) {
    const update = async () => {
      if (await writeAutoMemory(claudeSettingsTarget(), override)) await deps.onSaved?.('claude');
      return readAutoMemory();
    };
    return deps.withWrite ? deps.withWrite('claude', undefined, update) : update();
  }
  async function saveTarget(
    resource: ResourceTarget,
    input: NativeResourceSaveInput,
    notify = true,
  ): Promise<NativeResourceSaved> {
    if (resource.readOnly) throw new NativeResourceError('invalid_request');
    return transaction(resource.file, async () => {
      const data = validateContent(resource, input.content);
      await inspectDirectory(path.dirname(resource.file));
      const previous = await readConfigFile(resource.file);
      if (previous.revision !== input.revision) throw new NativeResourceError('revision_conflict');
      const parents = await inspectDirectory(path.dirname(resource.file), true);
      try {
        await writeConfigFile(resource.file, data, previous, parents!);
      } finally {
        if (notify) await deps.onSaved?.(resource.agent);
      }
      return { resource: await describeResource(resource), revision: contentRevision(data) };
    });
  }
  return {
    readAutoMemory,
    setAutoMemory,
    async withUserWrite<T>(agent: AgentKind, operation: (writer: NativeUserConfigWriter) => Promise<T>): Promise<T> {
      const run = async () => {
        try {
          return await operation({ save: async (id, input) => saveTarget(await target(agent, id), input, false) });
        } finally {
          await deps.onSaved?.(agent);
        }
      };
      return deps.withWrite ? deps.withWrite(agent, undefined, run) : run();
    },
    async list(agent: AgentKind, project?: NativeResourceProject): Promise<NativeResourceCatalog> {
      const { plan, targets, warnings } = await catalog(agent, project);
      return {
        agent,
        ...(project ? { projectId: project.id } : {}),
        entries: await Promise.all(targets.map(describeResource)),
        roots: await Promise.all(plan.roots.map(describeRoot)),
        guidance: plan.guidance,
        warnings,
      };
    },
    async open(agent: AgentKind, id: string, project?: NativeResourceProject): Promise<NativeResourceDocument> {
      const resource = await target(agent, id, project);
      return transaction(resource.file, async () => {
        const parents = await inspectDirectory(path.dirname(resource.file));
        const snapshot = parents ? await readConfigFile(resource.file) : { content: '', revision: 'missing' };
        if (parents) await assertDirectoryUnchanged(parents);
        return { resource: await describeResource(resource), content: snapshot.content, revision: snapshot.revision };
      });
    },
    async save(
      agent: AgentKind,
      id: string,
      input: NativeResourceSaveInput,
      project?: NativeResourceProject,
    ): Promise<NativeResourceSaved> {
      const operation = async () => saveTarget(await target(agent, id, project), input);
      return deps.withWrite ? deps.withWrite(agent, project, operation) : operation();
    },
    async create(
      agent: AgentKind,
      input: NativeResourceCreateInput,
      project?: NativeResourceProject,
    ): Promise<NativeResourceSaved> {
      const operation = async () => {
        const plan = resourcePlan(context(agent, project));
        const root = plan.roots.find((entry) => entry.id === input.rootId);
        if (!root) throw new NativeResourceError('resource_missing');
        const name = simpleName(input.name);
        if (root.kind === 'skills' && (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)))
          throw new NativeResourceError('invalid_request');
        const relative =
          root.kind === 'skills' ? path.join(name, 'SKILL.md') : name.endsWith('.md') ? name : `${name}.md`;
        const resource = makeResourceTarget(agent, root, relative, { kind: root.kind });
        return saveTarget(await protectClaudePluginResource(context(agent, project), resource), {
          content: input.content,
          revision: 'missing',
        });
      };
      return deps.withWrite ? deps.withWrite(agent, project, operation) : operation();
    },
  };
}
export type NativeResourcesService = ReturnType<typeof createNativeResourcesService>;
