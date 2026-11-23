import path from 'node:path';
import type { NativeSkillEntry } from '@agentdeck/shared/settings';
import { NativeResourceError, resourceError } from '../../agents/common/configuration/errors';
import { resourceId } from '../../agents/common/configuration/resources';
import { contentRevision, decodeUtf8, MAX_CONFIG_BYTES } from '../../platform/files/safe-file';
import { snapshotSkillTree } from './skill-tree';
import {
  enabledState,
  nativeSkillPathKey,
  type LocalSkill,
  type NativeSkill,
  type SkillAdapter,
  type SkillContext,
  type SkillRecord,
} from './types';

export function indexNativeSkillPaths(skills: NativeSkill[]) {
  const byPath = new Map<string, NativeSkill[]>();
  for (const skill of skills) {
    const key = nativeSkillPathKey(skill.path);
    if (!key) continue;
    const matches = byPath.get(key);
    if (matches) matches.push(skill);
    else byPath.set(key, [skill]);
  }
  return byPath;
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
async function localSnapshot(file: string) {
  const directory = path.dirname(file);
  const fallback = path.basename(directory);
  try {
    const { items, revision } = await snapshotSkillTree(directory);
    const skill = items.find((item) => item.path === 'SKILL.md');
    if (!skill) throw new NativeResourceError('resource_missing');
    if (skill.data.length > MAX_CONFIG_BYTES) throw new NativeResourceError('too_large');
    return { name: nameFrom(decodeUtf8(skill.data), fallback), treeRevision: revision };
  } catch (error) {
    return { name: fallback, treeRevision: 'unreadable', reason: resourceError(error).message };
  }
}

const readOnlyActions = (): NativeSkillEntry['actions'] => ({
  edit: false,
  delete: false,
  states: [],
  stateScopes: [],
});

function localOrigin(adapter: SkillAdapter, { resource, nativeSkill }: LocalSkill, conflict: boolean) {
  if (resource.owner) return resource.owner.kind;
  if (resource.scope === 'managed') return 'managed';
  return adapter.localOrigin?.(resource) ?? nativeSkill?.origin ?? (conflict ? 'external' : 'owned');
}
function localState(
  origin: NativeSkillEntry['origin'],
  nativeSkill: NativeSkill | undefined,
  state: NativeSkillEntry['state'],
) {
  if (origin === 'plugin') return nativeSkill?.fileOnly ? 'unknown' : enabledState(nativeSkill);
  return origin === 'managed' || origin === 'synced' ? 'unknown' : state;
}
function localAccess(
  adapter: SkillAdapter,
  local: LocalSkill,
  conflict: boolean,
  snapshotReason?: string,
): Pick<NativeSkillEntry, 'origin' | 'state' | 'stateByScope' | 'resourceId' | 'actions' | 'unavailableReason'> {
  const origin = localOrigin(adapter, local, conflict);
  if (conflict)
    return {
      origin,
      state: 'unknown',
      actions: readOnlyActions(),
      unavailableReason: '一个目录对应多个原生技能来源，无法单独修改。',
    };
  const { resource, nativeSkill } = local;
  const reason = resource.unavailableReason ?? snapshotReason;
  const owned = origin === 'owned' && resource.editable && !reason;
  const { state, states, scopes, stateByScope, unavailableReason } = adapter.visibility(local);
  return {
    origin,
    state: localState(origin, nativeSkill, state),
    stateByScope,
    resourceId: resource.id,
    actions: owned ? { edit: true, delete: true, states, stateScopes: scopes } : readOnlyActions(),
    unavailableReason: reason ?? unavailableReason,
  };
}
export async function localSkillEntry(
  adapter: SkillAdapter,
  input: Omit<LocalSkill, 'name' | 'nativeSkill'>,
  matches: NativeSkill[],
): Promise<SkillRecord> {
  const { resource, file, sources } = input;
  const conflict = matches.length > 1;
  const nativeSkill = conflict ? undefined : matches[0];
  const snapshot = await localSnapshot(file);
  const local = { ...input, nativeSkill, name: snapshot.name };
  const access = localAccess(adapter, local, conflict, snapshot.reason);
  const entry: NativeSkillEntry = {
    id: resource.id,
    name: nativeSkill?.name ?? snapshot.name,
    scope: resource.scope,
    source: resource.displayPath,
    fileOnly: !nativeSkill || nativeSkill.fileOnly,
    ...access,
    revision: contentRevision(
      Buffer.from(
        JSON.stringify([
          snapshot.treeRevision,
          sources.map((source) => [source.file, source.revision]),
          // 来源次序不影响修订；来源增减会使旧修订失效。
          matches.map((candidate) => JSON.stringify(candidate)).sort(),
        ]),
      ),
    ),
    description: nativeSkill?.description ?? '',
  };
  return { entry, file, treeRevision: snapshot.treeRevision, nativeSkill };
}
function nativeSourceId(context: SkillContext, skill: NativeSkill) {
  return resourceId(
    context.agent,
    skill.path ?? path.join(context.homeDir, '.native-skills', skill.name),
    `skill-source:${skill.nativeScope ?? skill.scope ?? 'unknown'}:${skill.source ?? ''}`,
  );
}
export function nativeSkillEntry(context: SkillContext, skill: NativeSkill): SkillRecord {
  const origin = skill.origin ?? (skill.path ? 'external' : 'builtin');
  return {
    entry: {
      id: nativeSourceId(context, skill),
      name: skill.name,
      scope: skill.scope ?? 'unknown',
      origin,
      source: skill.source ?? skill.path ?? 'CLI 内置技能',
      state: skill.fileOnly ? 'unknown' : enabledState(skill),
      revision: contentRevision(Buffer.from(JSON.stringify(skill))),
      description: skill.description ?? '',
      actions: readOnlyActions(),
      fileOnly: skill.fileOnly,
    },
    nativeSkill: skill,
  };
}
