import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type {
  NativeManagementResult,
  NativeSkillChangeInput,
  NativeSkillImportInput,
  NativeSkillsCatalog,
} from '@agentdeck/shared/settings';
import { NativeResourceError } from '../agents/common/configuration/errors';
import { resourcePathKey, type ResourceContext } from '../agents/common/configuration/resources';
import { claudeSkillConfig, changeClaudeSkill, readClaudeInstalledSkills } from '../agents/claude/configuration/skills';
import { antigravitySkillConfig, changeAntigravitySkill } from '../agents/antigravity/configuration/skills';
import { createCodexSkills } from '../agents/codex/configuration/skills';
import { discoverAntigravityCommands } from '../agents/antigravity/commands';
import { createNativeResourcesService } from '../settings/native-resources';
import { discoverResources } from '../settings/native-resources-discovery';
import { resourcePlan } from '../settings/resource-plan';
import { NativeManagementError, managementError } from './errors';
import { readSkillConfig } from './config';
import { deleteSkillTree, importSkillTree } from './skill-tree';
import type { NativeManagementAccess, NativeManagementProject, NativeSkill, SkillConfigSource } from './types';

type Deps = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  environment?: (agent: AgentKind) => Promise<NodeJS.ProcessEnv>;
  nativeSkills?: (agent: AgentKind, context: ResourceContext) => Promise<NativeSkill[]>;
  verifiedVersion?: (context: ResourceContext) => Promise<boolean>;
  writeCodexSkill?: (context: ResourceContext, file: string, enabled: boolean) => Promise<void>;
  access?: NativeManagementAccess;
  onChanged?: (agent: AgentKind) => void | Promise<void>;
};
import { localSkillEntry, nativeSkillEntry, restrictAgyConflicts, type InternalSkill } from './skill-entries';
import { verifiedSkillVersion } from './version';
export function createNativeManagementService(deps: Deps = {}) {
  const homeDir = path.resolve(deps.homeDir ?? os.homedir());
  const env = deps.env ?? process.env;
  async function context(agent: AgentKind, project?: NativeManagementProject): Promise<ResourceContext> {
    if (!['claude', 'codex', 'antigravity'].includes(agent)) throw new NativeResourceError('invalid_agent');
    return { agent, homeDir, env: deps.environment ? await deps.environment(agent) : env, project };
  }
  async function native(context: ResourceContext): Promise<NativeSkill[]> {
    if (deps.nativeSkills) return deps.nativeSkills(context.agent, context);
    if (context.agent === 'codex') return createCodexSkills({ env: context.env }).read(context.project?.dir ?? homeDir);
    if (context.agent === 'claude') return readClaudeInstalledSkills(context);
    return (await discoverAntigravityCommands(context.project?.dir ?? homeDir, { env: context.env, homeDir }))
      .filter((entry) => entry.kind === 'skill')
      .map((entry) => ({
        name: entry.name,
        path: entry.invocation?.kind === 'skill' ? entry.invocation.path : undefined,
        enabled: entry.available,
        origin: entry.name.includes(':') ? ('plugin' as const) : undefined,
      }));
  }
  async function config(context: ResourceContext) {
    if (context.agent === 'claude') return claudeSkillConfig(context);
    if (context.agent === 'antigravity') return antigravitySkillConfig(context);
    return [
      await readSkillConfig(path.join(context.env.CODEX_HOME || path.join(homeDir, '.codex'), 'config.toml'), 'user'),
      ...(context.project
        ? [await readSkillConfig(path.join(context.project.dir, '.codex/config.toml'), 'project')]
        : []),
    ];
  }
  async function inventory(current: ResourceContext) {
    const plan = resourcePlan(current);
    const resources = createNativeResourcesService({ homeDir, env: current.env });
    const [catalog, discovered, nativeResult, configResult, versionVerified] = await Promise.all([
      resources.list(current.agent, current.project),
      discoverResources(current, plan),
      native(current)
        .then((value) => ({ value }))
        .catch(() => ({ value: [] as NativeSkill[], failed: true })),
      config(current)
        .then((value) => ({ value }))
        .catch(() => ({ value: [] as SkillConfigSource[], failed: true })),
      verifyVersion(current),
    ]);
    const warnings = [...catalog.warnings];
    if ('failed' in nativeResult) warnings.push('原生状态暂时无法核实；仍可编辑已安全发现的本地文件。');
    if ('failed' in configResult) warnings.push('技能配置无法解析；请先从原文入口修复配置。');
    const sources = configResult.value;
    const records: InternalSkill[] = [];
    const foundPaths = new Set<string>();
    for (const resource of catalog.entries.filter(
      (entry) => entry.kind === 'skills' && /(?:^|\/)SKILL\.md$/.test(entry.displayPath),
    )) {
      const target = discovered.targets.find((entry) => entry.id === resource.id)!;
      const nativeSkill = nativeResult.value.find(
        (skill) => skill.path && resourcePathKey(skill.path) === resourcePathKey(target.file),
      );
      records.push(
        await localSkillEntry({
          context: current,
          resource,
          file: target.file,
          nativeSkill,
          sources,
          nativeAvailable: !('failed' in nativeResult),
        }),
      );
      foundPaths.add(resourcePathKey(target.file));
    }
    for (const skill of nativeResult.value) {
      if (skill.path && foundPaths.has(resourcePathKey(skill.path))) continue;
      records.push(nativeSkillEntry(current, skill));
    }
    if (current.agent === 'antigravity') restrictAgyConflicts(records);
    applyVersion(records, versionVerified, warnings);
    return { records, sources, catalog: { ...catalog, warnings } };
  }
  function verifyVersion(current: ResourceContext) {
    if (deps.verifiedVersion) return deps.verifiedVersion(current);
    return deps.nativeSkills ? Promise.resolve(true) : verifiedSkillVersion(current);
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
  async function remove(target: InternalSkill, input: NativeSkillChangeInput): Promise<NativeManagementResult> {
    if (!target.entry.actions.delete || !target.directory) throw new NativeManagementError('unsupported_action');
    if (input.confirmation !== target.entry.name) throw new NativeManagementError('confirmation_required');
    await deleteSkillTree(target.directory, target.treeRevision!);
    return { status: 'deleted', nextTurn: true };
  }
  async function changeState(
    current: ResourceContext,
    target: InternalSkill,
    input: NativeSkillChangeInput,
    sources: SkillConfigSource[],
  ) {
    assertStateAction(target, input);
    if (current.agent === 'claude') return changeClaudeSkill(target.entry.name, input, sources);
    if (current.agent === 'antigravity') {
      await changeAntigravitySkill(target.selector!, input, sources);
      return verifyAntigravityState(current, target, input);
    }
    if (!target.nativePath) throw new NativeManagementError('unsupported_action');
    if (deps.writeCodexSkill) return deps.writeCodexSkill(current, target.nativePath, input.value === 'enabled');
    await createCodexSkills({ env: current.env }).write(
      current.project?.dir ?? homeDir,
      target.nativePath,
      input.value === 'enabled',
    );
  }
  async function verifyAntigravityState(
    current: ResourceContext,
    target: InternalSkill,
    input: NativeSkillChangeInput,
  ) {
    try {
      const file = path.join(target.directory!, 'SKILL.md');
      const matches = (await native(current)).filter(
        (skill) => skill.path && resourcePathKey(skill.path) === resourcePathKey(file),
      );
      const confirmed =
        input.value === 'enabled'
          ? matches.length === 1 && matches[0]?.enabled === true
          : matches.every((skill) => skill.enabled === false);
      if (!confirmed) throw new NativeManagementError('result_unconfirmed');
    } catch {
      throw new NativeManagementError('result_unconfirmed');
    }
  }
  return {
    async readSkills(agent: AgentKind, project?: NativeManagementProject): Promise<NativeSkillsCatalog> {
      return read(agent, async () => {
        const value = await inventory(await context(agent, project));
        return {
          agent,
          ...(project ? { projectId: project.id } : {}),
          entries: value.records.map((record) => record.entry),
          roots: value.catalog.roots.filter((root) => root.kind === 'skills'),
          warnings: value.catalog.warnings,
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
          if (input.action === 'delete') return remove(target, input);
          await changeState(current, target, input, value.sources);
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
function applyVersion(records: InternalSkill[], verified: boolean, warnings: string[]) {
  if (verified) return;
  for (const { entry } of records) {
    entry.actions.states = [];
    entry.actions.stateScopes = [];
    entry.state = 'unknown';
  }
  warnings.push('当前 CLI 版本尚未核实技能状态写入；可继续编辑自有文件或使用原生入口。');
}
function assertStateAction(target: InternalSkill, input: NativeSkillChangeInput) {
  if (
    !input.value ||
    !target.entry.actions.states.includes(input.value) ||
    !input.scope ||
    !target.entry.actions.stateScopes.includes(input.scope)
  )
    throw new NativeManagementError('unsupported_action');
}
export type NativeManagementService = ReturnType<typeof createNativeManagementService>;
