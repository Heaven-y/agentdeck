import path from 'node:path';
import type { NativeResource, NativeSkillEntry, NativeSkillOrigin, NativeSkillState } from '@agentdeck/shared/settings';
import { resourcePathKey, type ResourceContext } from '../../agents/common/configuration/resources';
import type { NativeConfigSource } from '../config';

export type SkillContext = ResourceContext;
export type NativeSkill = {
  name: string;
  path?: string;
  scope?: NativeSkillEntry['scope'];
  /** CLI 的原始作用域用于保持已有来源 ID，展示作用域可单独归一化。 */
  nativeScope?: string;
  enabled?: boolean;
  origin?: NativeSkillOrigin;
  source?: string;
  ownerRoot?: string;
};
export function enabledState(skill?: NativeSkill): NativeSkillState {
  if (skill?.enabled === undefined) return 'unknown';
  return skill.enabled ? 'enabled' : 'disabled';
}
export function nativeSkillPathKey(file?: string): string | undefined {
  return file && path.isAbsolute(file) ? resourcePathKey(file) : undefined;
}

export type SkillRecord = {
  entry: NativeSkillEntry;
  file?: string;
  treeRevision?: string;
  nativeSkill?: NativeSkill;
};
export type LocalSkill = {
  context: SkillContext;
  resource: NativeResource;
  file: string;
  name: string;
  nativeSkill?: NativeSkill;
  sources: NativeConfigSource[];
  nativeAvailable: boolean;
};
export type SkillVisibility = Pick<NativeSkillEntry, 'state' | 'stateByScope' | 'unavailableReason'> & {
  states: NativeSkillState[];
  scopes: NativeSkillEntry['actions']['stateScopes'];
};
export type SkillStateChange = {
  name: string;
  file: string;
  nativeSkill?: NativeSkill;
  scope: NativeConfigSource['scope'];
  value: NativeSkillState;
};
export type SkillAdapter = {
  readNative(context: SkillContext): Promise<NativeSkill[]>;
  readConfig(context: SkillContext): Promise<NativeConfigSource[]>;
  verifyVersion(context: SkillContext): Promise<boolean>;
  localOrigin?(resource: NativeResource): NativeSkillOrigin | undefined;
  visibility(skill: LocalSkill): SkillVisibility;
  restrictConflicts?(records: SkillRecord[]): void;
  changeState(context: SkillContext, change: SkillStateChange, sources: NativeConfigSource[]): Promise<void>;
};
