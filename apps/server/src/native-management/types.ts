import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativeResourceScope, NativeSkillOrigin } from '@agentdeck/shared/settings';
import type { ResourceContext } from '../agents/common/configuration/resources';

export type NativeSkill = {
  name: string;
  path?: string;
  scope?: string;
  enabled?: boolean;
  origin?: NativeSkillOrigin;
  source?: string;
  ownerRoot?: string;
};
export type NativeManagementProject = { id: string; dir: string };
export type NativeManagementAccess = {
  read<T>(agent: AgentKind, operation: () => Promise<T>): Promise<T>;
  write<T>(agent: AgentKind, project: NativeManagementProject | undefined, operation: () => Promise<T>): Promise<T>;
};
export type SkillConfigSource = {
  file: string;
  scope: NativeResourceScope;
  content: string;
  revision: string;
  data: Record<string, unknown>;
};
export type SkillContext = ResourceContext;
