import path from 'node:path';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativeResource, NativeSkillEntry, NativeSkillState } from '@agentdeck/shared/settings';
import { resourceError } from '../../agents/common/configuration/errors';
import { resourceId, type ResourceContext } from '../../agents/common/configuration/resources';
import { claudeSkillState, claudeSkillStates } from '../../agents/claude/configuration/skills';
import { antigravitySkillState, simpleSkillManifest } from '../../agents/antigravity/configuration/skills';
import { contentRevision, readConfigFile } from '../../platform/files/safe-file';
import { snapshotSkillTree } from './skill-tree';
import type { NativeSkill } from './types';
import type { NativeConfigSource } from '../config';

export type InternalSkill = {
  entry: NativeSkillEntry;
  directory?: string;
  treeRevision?: string;
  nativePath?: string;
  selector?: string;
};
type EntryContext = {
  context: ResourceContext;
  resource: NativeResource;
  file: string;
  nativeSkill?: NativeSkill;
  sources: NativeConfigSource[];
  nativeAvailable?: boolean;
};
type Visibility = Pick<NativeSkillEntry, 'state' | 'unavailableReason'> & {
  states: NativeSkillState[];
  scopes: NativeSkillEntry['actions']['stateScopes'];
};
const scopeNames: Record<string, NativeSkillEntry['scope']> = {
  repo: 'project',
  user: 'user',
  system: 'system',
  admin: 'admin',
  project: 'project',
  local: 'local',
};
const originNames: Record<string, NativeSkillEntry['origin']> = {
  plugin: 'plugin',
  admin: 'managed',
  system: 'builtin',
};
function contained(root: string, file: string) {
  const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function nameFrom(content: string, fallback: string) {
  const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  const value = front
    ?.match(/^name:\s*([^\r\n]+)$/m)?.[1]
    ?.trim()
    .replace(/^(['"])(.*)\1$/, '$2');
  if (!value || value.length > 200 || /[\s/\\]/.test(value)) return fallback;
  return [...value].some((character) => character.charCodeAt(0) < 32) ? fallback : value;
}
function description(agent: AgentKind, origin: NativeSkillEntry['origin']) {
  if (origin === 'plugin') return '此技能随所属原生插件启停，请在插件管理中操作。';
  if (agent === 'claude') return '可见性按原生技能名应用，同名用户与项目技能共享该设置；默认继承保留原生配置。';
  if (agent === 'codex') return '启停按原生技能文件路径保存到 Codex 用户配置；项目可信状态仍由 Codex 决定。';
  return '原生清单按名称排除；私有与 Shared 技能不受此开关控制。';
}
function originOf(value: EntryContext): NativeSkillEntry['origin'] {
  if (value.resource.owner) return 'plugin';
  if (value.resource.scope === 'managed') return 'managed';
  if (value.resource.displayPath.includes('/plugins/')) return 'plugin';
  if (value.resource.displayPath.includes('/synced/')) return 'synced';
  return value.nativeSkill?.origin ?? originNames[value.nativeSkill?.scope ?? ''] ?? 'owned';
}
function enabledState(skill?: NativeSkill): NativeSkillState {
  if (skill?.enabled === undefined) return 'unknown';
  return skill.enabled ? 'enabled' : 'disabled';
}
function claudeVisibility(value: EntryContext, name: string, owned: boolean): Visibility {
  const canWrite = owned && value.sources.length > 0;
  return {
    state: value.sources.length ? claudeSkillState(name, value.sources) : 'unknown',
    states: canWrite ? claudeSkillStates : [],
    scopes: canWrite ? value.sources.map((source) => source.scope) : [],
  };
}
function codexVisibility(value: EntryContext, owned: boolean): Visibility {
  const canWrite = owned && !!value.nativeSkill && value.sources.length > 0;
  return {
    state: enabledState(value.nativeSkill),
    states: canWrite ? ['enabled', 'disabled'] : [],
    scopes: canWrite ? ['user'] : [],
  };
}
function agyVisibility(value: EntryContext, selector: string, owned: boolean): Visibility {
  if (value.nativeAvailable === false) return { state: 'unknown', states: [], scopes: [] };
  const { homeDir } = value.context;
  const privateSkill = ['.gemini/antigravity-cli/skills', '.gemini/skills'].some((root) =>
    contained(path.join(homeDir, root), value.file),
  );
  if (privateSkill)
    return {
      state: enabledState(value.nativeSkill),
      states: [],
      scopes: [],
      unavailableReason: '此目录不受原生清单排除控制，可编辑或删除自有技能。',
    };
  if (!value.sources.every(simpleSkillManifest))
    return {
      state: enabledState(value.nativeSkill),
      states: [],
      scopes: [],
      unavailableReason: '此技能受继承或路径过滤清单管理，请从原文入口编辑。',
    };
  const source = value.sources.find((item) => item.scope === value.resource.scope);
  const configured = antigravitySkillState(selector, value.sources);
  const state = agyState(value.nativeSkill, configured);
  const canWrite = owned && state !== 'unknown' && !!source;
  return {
    state,
    states: canWrite ? ['enabled', 'disabled'] : [],
    scopes: canWrite ? [source.scope] : [],
  };
}
function visibility(value: EntryContext, name: string, owned: boolean) {
  if (value.context.agent === 'claude') return claudeVisibility(value, name, owned);
  if (value.context.agent === 'codex') return codexVisibility(value, owned);
  return agyVisibility(value, path.basename(path.dirname(value.file)), owned);
}
function agyState(skill: NativeSkill | undefined, configured: NativeSkillState): NativeSkillState {
  if (skill) return enabledState(skill);
  return configured === 'disabled' ? 'disabled' : 'unknown';
}
async function localSnapshot(file: string) {
  const directory = path.dirname(file);
  try {
    return {
      name: nameFrom((await readConfigFile(file)).content, path.basename(directory)),
      treeRevision: (await snapshotSkillTree(directory)).revision,
    };
  } catch (error) {
    return { name: path.basename(directory), treeRevision: 'unreadable', reason: resourceError(error).message };
  }
}
export async function localSkillEntry(value: EntryContext): Promise<InternalSkill> {
  const { resource, sources, nativeSkill } = value;
  const snapshot = await localSnapshot(value.file);
  const reason = resource.unavailableReason ?? snapshot.reason;
  const origin = originOf(value);
  const owned = origin === 'owned' && resource.editable && !reason;
  const options = visibility(value, snapshot.name, owned);
  options.state = originState(origin, nativeSkill, options.state);
  const entry: NativeSkillEntry = {
    id: resource.id,
    name: snapshot.name,
    scope: resource.scope,
    origin,
    source: resource.displayPath,
    state: options.state,
    revision: contentRevision(
      Buffer.from(
        JSON.stringify([snapshot.treeRevision, sources.map((source) => [source.file, source.revision]), nativeSkill]),
      ),
    ),
    resourceId: resource.id,
    description: description(value.context.agent, origin),
    actions: { edit: owned, delete: owned, states: options.states, stateScopes: options.scopes },
  };
  if (value.context.agent === 'claude')
    entry.stateByScope = Object.fromEntries(
      sources.map((source) => [source.scope, claudeSkillState(snapshot.name, [source])]),
    );
  const unavailableReason = reason ?? options.unavailableReason;
  if (unavailableReason) entry.unavailableReason = unavailableReason;
  return {
    entry,
    directory: path.dirname(value.file),
    treeRevision: snapshot.treeRevision,
    nativePath: nativeSkill?.path,
    selector: path.basename(path.dirname(value.file)),
  };
}
function originState(
  origin: NativeSkillEntry['origin'],
  skill: NativeSkill | undefined,
  state: NativeSkillState,
): NativeSkillState {
  if (origin === 'plugin') return enabledState(skill);
  if (origin === 'managed' || origin === 'synced') return 'unknown';
  return state;
}
export function nativeSkillEntry(context: ResourceContext, skill: NativeSkill): InternalSkill {
  const origin = nativeOrigin(skill);
  return {
    entry: {
      id: resourceId(
        context.agent,
        skill.path ?? path.join(context.homeDir, '.native-skills', skill.name),
        `skill-source:${skill.scope ?? 'unknown'}:${skill.source ?? ''}`,
      ),
      name: skill.name,
      scope: scopeNames[skill.scope ?? ''] ?? 'unknown',
      origin,
      source: skill.source ?? skill.path ?? 'CLI 内置技能',
      state: enabledState(skill),
      revision: contentRevision(Buffer.from(JSON.stringify(skill))),
      description: description(context.agent, origin),
      actions: { edit: false, delete: false, states: [], stateScopes: [] },
      unavailableReason: origin === 'plugin' ? '请通过所属插件管理。' : '此来源由原生 CLI 管理，仅显示状态。',
    },
    ...(skill.path ? { selector: path.basename(path.dirname(skill.path)) } : {}),
  };
}
function nativeOrigin(skill: NativeSkill): NativeSkillEntry['origin'] {
  return skill.origin ?? originNames[skill.scope ?? ''] ?? (skill.path ? 'external' : 'builtin');
}
export function restrictAgyConflicts(records: InternalSkill[]) {
  const counts = new Map<string, number>();
  for (const record of records) {
    const selector = record.selector ?? record.entry.name;
    counts.set(selector, (counts.get(selector) ?? 0) + 1);
  }
  for (const { entry, selector } of records)
    if (counts.get(selector ?? entry.name)! > 1) {
      entry.actions.states = [];
      entry.actions.stateScopes = [];
      entry.unavailableReason = '存在同名来源，请从原生清单明确管理影响范围。';
    }
}
