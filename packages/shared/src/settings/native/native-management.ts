import type { AgentKind } from '../../conversation/agents';
import type { NativeResourceRoot, NativeResourceScope } from './native-resources';

export type NativeManagementContext = { agent: AgentKind; projectId?: string };
export type NativeSkillState =
  'inherit' | 'on' | 'name-only' | 'user-invocable-only' | 'off' | 'enabled' | 'disabled' | 'unknown';
export type NativeSkillOrigin = 'owned' | 'plugin' | 'managed' | 'builtin' | 'external' | 'synced';
export type NativeSkillEntry = {
  id: string;
  name: string;
  scope: NativeResourceScope | 'system' | 'admin' | 'unknown';
  origin: NativeSkillOrigin;
  source: string;
  state: NativeSkillState;
  stateByScope?: Partial<Record<NativeResourceScope, NativeSkillState>>;
  revision: string;
  resourceId?: string;
  /** 原生按名称修改时明确告知影响范围；不能将其伪装成路径级开关。 */
  description: string;
  actions: { edit: boolean; delete: boolean; states: NativeSkillState[]; stateScopes: NativeResourceScope[] };
  unavailableReason?: string;
};
export type NativeSkillsCatalog = {
  agent: AgentKind;
  projectId?: string;
  entries: NativeSkillEntry[];
  roots: NativeResourceRoot[];
  warnings: string[];
};
export type NativeSkillChangeInput = {
  id: string;
  revision: string;
  action: 'state' | 'delete';
  value?: NativeSkillState;
  scope?: NativeResourceScope;
  confirmation?: string;
};
/** 目录选择由浏览器完成，服务器不接受客户端提供的本机绝对源路径。 */
export type NativeSkillImportInput = {
  rootId: string;
  name: string;
  files: Array<{ path: string; contentBase64: string }>;
};
export type NativeManagementResult = { status: 'saved' | 'deleted'; nextTurn: true };
