import os from 'node:os';
import path from 'node:path';
import { isAgentKind, type AgentKind } from '@agentdeck/shared/conversation';
import type {
  NativeManagementResult,
  NativeSkillChangeInput,
  NativeSkillImportInput,
  NativeSkillsCatalog,
} from '@agentdeck/shared/settings';
import { NativeResourceError } from '../../agents/common/configuration/errors';
import {
  resourcePathKey,
  type ResourceContext,
  type ResourceTarget,
} from '../../agents/common/configuration/resources';
import {
  describeResource,
  describeRoot,
  discoverResources,
  type LinkedSkill,
} from '../../settings/resources/native-resources-discovery';
import { resourcePlan } from '../../settings/resources/resource-plan';
import { NativeManagementError, managementError } from '../errors';
import { deleteSkillTree, importSkillTree } from './skill-tree';
import type { NativeManagementAccess, NativeManagementProject } from '../access';
import { skillAdapters } from './adapters';
import { claudeLinkedEntry, localSkillEntry, nativeSkillEntry, indexNativeSkillPaths } from './skill-entries';
import { nativeSkillPathKey, type SkillAdapter, type SkillRecord, type NativeSkill } from './types';

type Deps = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  environment?: (agent: AgentKind) => Promise<NodeJS.ProcessEnv>;
  adapters?: Record<AgentKind, SkillAdapter>;
  access?: NativeManagementAccess;
  onChanged?: (agent: AgentKind) => void | Promise<void>;
};
async function readList<T>(read: () => Promise<T[]>): Promise<{ rows: T[]; available: boolean }> {
  try {
    return { rows: await read(), available: true };
  } catch {
    return { rows: [], available: false };
  }
}
function disableUnverifiedWrites(records: SkillRecord[]) {
  for (const { entry } of records) {
    if (!entry.actions.states.length) continue;
    entry.actions.states = [];
    entry.actions.stateScopes = [];
    entry.unavailableReason ??= '当前 CLI 版本的技能设置格式未验证。';
  }
}
const scopedFile = (scope: string, file: string) => `${scope}:${resourcePathKey(file)}`;

function indexLinks(links: LinkedSkill[]) {
  const byPath = new Map<string, Map<string, LinkedSkill>>();
  for (const link of links) {
    for (const file of [link.alias.file, link.file]) {
      const key = resourcePathKey(file);
      const matches = byPath.get(key) ?? new Map<string, LinkedSkill>();
      if (!matches.has(link.alias.scope)) matches.set(link.alias.scope, link);
      byPath.set(key, matches);
    }
  }
  return (key: string, scope?: NativeSkill['scope']) => {
    const matches = byPath.get(key);
    if (scope && scope !== 'unknown') return matches?.get(scope);
    // 原生没有给作用域时，只有唯一配置来源才能用于归类。
    return matches?.size === 1 ? matches.values().next().value : undefined;
  };
}

type DirectSkills = Map<string, SkillRecord[]>;
type AddDirectSkill = (file: string, record: SkillRecord) => void;
type NativeInventory = { rows: NativeSkill[]; available: boolean };
type SkillInventoryInput = { native: NativeInventory; sources: Awaited<ReturnType<SkillAdapter['readConfig']>> };

function bundleParent(file: string, { scope, origin }: SkillRecord['entry'], direct: DirectSkills) {
  let directory = path.dirname(file);
  while (path.dirname(directory) !== directory) {
    directory = path.dirname(directory);
    const parents = direct
      .get(scopedFile(scope, path.join(directory, 'SKILL.md')))
      ?.filter(
        (candidate) =>
          candidate.entry.origin === origin || (candidate.entry.origin === 'owned' && origin === 'external'),
      );
    if (parents?.length) return parents.length === 1 ? parents[0] : undefined;
  }
}

function groupSkillBundles(records: SkillRecord[], direct: DirectSkills, links: LinkedSkill[]) {
  for (const link of links) {
    const physical = direct.get(scopedFile(link.alias.scope, link.file));
    const alias = scopedFile(link.alias.scope, link.alias.file);
    if (physical && !direct.has(alias)) direct.set(alias, physical);
  }
  const topLevel = new Set([...direct.values()].flat());
  for (const record of records) {
    const file = record.nativeSkill?.path;
    if (!file || !path.isAbsolute(file) || topLevel.has(record)) continue;
    const parent = bundleParent(file, record.entry, direct);
    if (parent) record.entry.parentSkillId = parent.entry.id;
  }
}

async function addOrdinarySkills(
  context: ResourceContext,
  adapter: SkillAdapter,
  { targets, native, sources }: SkillInventoryInput & { targets: ResourceTarget[] },
  addDirect: AddDirectSkill,
) {
  const foundPaths = new Set<string>();
  const byPath = indexNativeSkillPaths(native.rows);
  for (const target of targets) {
    if (target.kind !== 'skills' || path.basename(target.file) !== 'SKILL.md') continue;
    const key = resourcePathKey(target.file);
    const record = await localSkillEntry(
      adapter,
      {
        context,
        resource: await describeResource(target),
        file: target.file,
        sources,
        nativeAvailable: native.available,
      },
      byPath.get(key) ?? [],
    );
    addDirect(target.file, record);
    foundPaths.add(key);
  }
  return foundPaths;
}

function addNativeSkills(
  context: ResourceContext,
  rows: NativeSkill[],
  { foundPaths, links }: { foundPaths: Set<string>; links: LinkedSkill[] },
  { records, addDirect }: { records: SkillRecord[]; addDirect: AddDirectSkill },
) {
  const getLink = indexLinks(links);
  for (const skill of rows) {
    const key = nativeSkillPathKey(skill.path);
    if (key && foundPaths.has(key)) continue;
    const link = key && !skill.origin && getLink(key, skill.scope);
    if (link) {
      const record = nativeSkillEntry(context, { ...skill, scope: link.alias.scope, source: link.alias.displayPath });
      addDirect(link.file, record);
    } else records.push(nativeSkillEntry(context, skill));
  }
}

async function addClaudeLinks(
  context: ResourceContext,
  links: LinkedSkill[],
  direct: DirectSkills,
  addDirect: AddDirectSkill,
) {
  // Claude 的插件清单不包含个人和项目技能，链接从登记目录的 SKILL.md 读取简介。
  for (const link of links) {
    if (direct.has(scopedFile(link.alias.scope, link.file))) continue;
    const record = await claudeLinkedEntry(context, link).catch(() => undefined);
    if (record) addDirect(link.file, record);
  }
}

async function skillRecords(
  context: ResourceContext,
  adapter: SkillAdapter,
  { targets, linkedSkills }: { targets: ResourceTarget[]; linkedSkills: LinkedSkill[] },
  { native, sources }: SkillInventoryInput,
) {
  const records: SkillRecord[] = [];
  const direct: DirectSkills = new Map();
  function addDirect(file: string, record: SkillRecord) {
    const key = scopedFile(record.entry.scope, file);
    const previous = direct.get(key) ?? [];
    if (previous.some((item) => item.entry.name === record.entry.name)) return;
    direct.set(key, [...previous, record]);
    records.push(record);
  }
  const foundPaths = await addOrdinarySkills(context, adapter, { targets, native, sources }, addDirect);
  addNativeSkills(context, native.rows, { foundPaths, links: linkedSkills }, { records, addDirect });
  if (context.agent === 'claude') await addClaudeLinks(context, linkedSkills, direct, addDirect);
  groupSkillBundles(records, direct, linkedSkills);
  adapter.restrictConflicts?.(records);
  return records;
}
export function createNativeManagementService(deps: Deps = {}) {
  const homeDir = path.resolve(deps.homeDir ?? os.homedir());
  const env = deps.env ?? process.env;
  const adapters = deps.adapters ?? skillAdapters;
  async function context(agent: AgentKind, project?: NativeManagementProject): Promise<ResourceContext> {
    if (!isAgentKind(agent)) throw new NativeResourceError('invalid_agent');
    return { agent, homeDir, env: deps.environment ? await deps.environment(agent) : env, project };
  }
  async function inventory(current: ResourceContext) {
    const adapter = adapters[current.agent];
    const plan = resourcePlan(current);
    const [discovered, native, config, verified] = await Promise.all([
      discoverResources(
        current,
        {
          ...plan,
          targets: plan.targets.filter((target) => target.kind === 'skills'),
          scans: plan.scans.filter((scan) => scan.mode === 'skills' || scan.mode === 'plugins'),
        },
        'skills',
      ),
      readList(() => adapter.readNative(current)),
      readList(() => adapter.readConfig(current)),
      adapter.verifyVersion?.(current) ?? true,
    ]);
    const warnings = discovered.warnings;
    if (!native.available) warnings.push('原生技能未读到，下方仅列已发现的本地文件。');
    if (!config.available) warnings.push('技能配置读取失败，请打开配置文件检查。');
    const records = await skillRecords(current, adapter, discovered, { native, sources: config.rows });
    if (!verified) disableUnverifiedWrites(records);
    return { records, sources: config.rows, roots: plan.roots.filter((root) => root.kind === 'skills'), warnings };
  }
  const read = <T>(agent: AgentKind, operation: () => Promise<T>) =>
    deps.access ? deps.access.read(agent, operation) : operation();
  const write = <T>(agent: AgentKind, project: NativeManagementProject | undefined, operation: () => Promise<T>) => {
    const run = async () => {
      try {
        return await operation();
      } finally {
        await deps.onChanged?.(agent);
      }
    };
    return deps.access ? deps.access.write(agent, project, run) : run();
  };
  async function remove(target: SkillRecord, input: NativeSkillChangeInput): Promise<NativeManagementResult> {
    if (!target.entry.actions.delete || !target.file) throw new NativeManagementError('unsupported_action');
    if (input.confirmation !== target.entry.name) throw new NativeManagementError('confirmation_required');
    await deleteSkillTree(path.dirname(target.file), target.treeRevision!);
    return { status: 'deleted', nextTurn: true };
  }
  return {
    async readSkills(agent: AgentKind, project?: NativeManagementProject): Promise<NativeSkillsCatalog> {
      return read(agent, async () => {
        const value = await inventory(await context(agent, project));
        return {
          agent,
          ...(project ? { projectId: project.id } : {}),
          entries: value.records.map((record) => record.entry),
          roots: await Promise.all(value.roots.map(describeRoot)),
          warnings: value.warnings,
        };
      });
    },
    async changeSkill(
      agent: AgentKind,
      input: NativeSkillChangeInput,
      project?: NativeManagementProject,
    ): Promise<NativeManagementResult> {
      return write(agent, project, async () => {
        try {
          const current = await context(agent, project);
          const value = await inventory(current);
          const target = value.records.find((record) => record.entry.id === input.id);
          if (!target) throw new NativeResourceError('resource_missing');
          if (target.entry.revision !== input.revision) throw new NativeResourceError('revision_conflict');
          if (input.action === 'delete') return await remove(target, input);
          if (
            !target.file ||
            !input.value ||
            !target.entry.actions.states.includes(input.value) ||
            !input.scope ||
            !target.entry.actions.stateScopes.includes(input.scope)
          )
            throw new NativeManagementError('unsupported_action');
          await adapters[agent].changeState(
            current,
            {
              name: target.entry.name,
              file: target.file,
              nativeSkill: target.nativeSkill,
              scope: input.scope,
              value: input.value,
            },
            value.sources,
          );
          return { status: 'saved', nextTurn: true };
        } catch (error) {
          throw managementError(error);
        }
      });
    },
    async importSkill(
      agent: AgentKind,
      input: NativeSkillImportInput,
      project?: NativeManagementProject,
    ): Promise<NativeManagementResult> {
      return write(agent, project, async () => {
        try {
          const current = await context(agent, project);
          const root = resourcePlan(current).roots.find((root) => root.kind === 'skills' && root.id === input.rootId);
          if (!root) throw new NativeResourceError('resource_missing');
          await importSkillTree(root.directory, input);
          return { status: 'saved', nextTurn: true };
        } catch (error) {
          throw managementError(error);
        }
      });
    },
  };
}
export type NativeManagementService = ReturnType<typeof createNativeManagementService>;
