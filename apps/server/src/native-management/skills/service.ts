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
import { resourcePathKey, type ResourceContext } from '../../agents/common/configuration/resources';
import { describeResource, describeRoot, discoverResources } from '../../settings/resources/native-resources-discovery';
import { resourcePlan } from '../../settings/resources/resource-plan';
import { NativeManagementError, managementError } from '../errors';
import { deleteSkillTree, importSkillTree } from './skill-tree';
import type { NativeManagementAccess, NativeManagementProject } from '../access';
import { skillAdapters } from './adapters';
import { localSkillEntry, nativeSkillEntry, indexNativeSkillPaths } from './skill-entries';
import { nativeSkillPathKey, type SkillAdapter, type SkillRecord } from './types';

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
      discoverResources(current, plan),
      readList(() => adapter.readNative(current)),
      readList(() => adapter.readConfig(current)),
      adapter.verifyVersion(current),
    ]);
    const warnings = discovered.warnings;
    if (!native.available) warnings.push('技能状态读取失败，请重新读取。');
    if (!config.available) warnings.push('技能配置读取失败，请打开配置文件检查。');
    const records: SkillRecord[] = [];
    const foundPaths = new Set<string>();
    const byPath = indexNativeSkillPaths(native.rows);
    for (const target of discovered.targets.filter(
      (item) => item.kind === 'skills' && path.basename(item.file) === 'SKILL.md',
    )) {
      const key = resourcePathKey(target.file);
      records.push(
        await localSkillEntry(
          adapter,
          {
            context: current,
            resource: await describeResource(target),
            file: target.file,
            sources: config.rows,
            nativeAvailable: native.available,
          },
          byPath.get(key) ?? [],
        ),
      );
      foundPaths.add(key);
    }
    for (const skill of native.rows) {
      const key = nativeSkillPathKey(skill.path);
      if (key && foundPaths.has(key)) continue;
      records.push(nativeSkillEntry(current, skill));
    }
    adapter.restrictConflicts?.(records);
    applyVersion(records, verified, warnings);
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
function applyVersion(records: SkillRecord[], verified: boolean, warnings: string[]) {
  if (verified) return;
  for (const { entry } of records) {
    entry.actions.states = [];
    entry.actions.stateScopes = [];
    entry.state = 'unknown';
  }
  warnings.push('当前版本暂不能在此修改技能启用状态，可编辑技能文件或在 CLI 中管理。');
}
export type NativeManagementService = ReturnType<typeof createNativeManagementService>;
