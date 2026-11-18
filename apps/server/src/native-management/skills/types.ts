import type { NativeSkillOrigin } from '@agentdeck/shared/settings';
import type { ResourceContext } from '../../agents/common/configuration/resources';

export type NativeSkill = {
  name: string;
  path?: string;
  scope?: string;
  enabled?: boolean;
  origin?: NativeSkillOrigin;
  source?: string;
  ownerRoot?: string;
};
export type SkillContext = ResourceContext;
