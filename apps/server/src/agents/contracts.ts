import type { PermissionSelection } from '@agentdeck/shared/conversation';
import type { ChatAttachment } from '@agentdeck/shared/conversation';
import type { NativeMediaLocator } from '@agentdeck/shared/conversation';
import type { RuntimeTaskSnapshot } from '@agentdeck/shared/conversation';
export type { RuntimeTaskSnapshot } from '@agentdeck/shared/conversation';
import type { InteractionSpec, InteractionAnswer, InteractionOwner } from '@agentdeck/shared/conversation';
import type {
  AgentEvent,
  SessionActionInput,
  SessionCapabilities,
  SessionForkInput,
  SessionRecord,
  SubagentQuery,
  SubagentRead,
} from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import type { NativeInvocation } from './capability-types';

export type PermissionAnswer = { allow: boolean; message?: string };
export type NativeInteractionRequest = {
  spec: InteractionSpec;
  runtimeId: string;
  completionId?: string;
  scope?: Pick<InteractionOwner, 'kind' | 'id'>;
};
export type InteractionRequester = (
  request: NativeInteractionRequest,
  options?: { signal?: AbortSignal },
) => Promise<InteractionAnswer>;
export type AgentTurnInput = {
  workspace: Workspace;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  collaborationMode?: 'default' | 'plan';
  permission?: PermissionSelection;
  text: string;
  attachments?: NativeAttachment[];
  attachmentsStored?: (ids: string[]) => Promise<void>;
  /** 原生回显/受理响应的身份；与网页请求送达回执区分。 */
  clientMessageId?: string;
  onInputAccepted?: () => void;
  invocation?: NativeInvocation;
  emit(event: AgentEvent): void;
  requestPermission(request: { requestId: string; toolName: string; input: unknown }): Promise<PermissionAnswer>;
  requestInteraction?: InteractionRequester;
  completeInteraction?(runtimeId: string, completionId: string): void;
  registerRuntime?: (control: RuntimeControl) => void;
};
export type NativeAttachment = ChatAttachment & { path: string; data: Buffer };
export type NativeInputResult = { status: 'accepted' | 'rejected' | 'unknown'; message?: string };
export type NativeSteerInput = {
  clientMessageId: string;
  text: string;
  attachments?: NativeAttachment[];
  onAccepted?: () => void;
  attachmentsStored?: (ids: string[]) => Promise<void>;
};
export type TurnHandle = {
  interrupt(): Promise<void>;
  done: Promise<void>;
  canSteer?: () => boolean;
  steer?: (input: NativeSteerInput) => Promise<NativeInputResult>;
};
/** 会话实例控制独立于单轮，后台任务仍存活时不能随 TurnHandle 完成而丢弃。 */
export type RuntimeControl = {
  readonly instanceId: string;
  readonly sessionId: string;
  tasks(): readonly RuntimeTaskSnapshot[];
  readonly taskActivity?: boolean;
  readonly taskWarning?: string;
  subscribe?(listener: () => void): () => void;
  close?(): Promise<void>;
  readonly alive?: boolean;
  stopTask(id: string): Promise<void>;
  /** 标记技能/MCP/插件等资源过期，阻止旧实例后续复用；不能据此中断活动任务。 */
  invalidateResources(): Promise<void>;
};
export type TurnRunner = ((input: AgentTurnInput) => TurnHandle) & {
  /** 只返回已核实归属的活实例；未实现时不声明后台任务停止能力。 */
  runtimeControl?(sessionId: string): RuntimeControl | undefined;
  hasBackground?(): boolean;
  /** 关闭长驻运行时；单轮实现可省略。 */
  dispose?(): Promise<void>;
};
/** 各 CLI 的原生会话行：只有原生元数据，不含项目归属与运行态。 */
export type NativeSessionSummary = Omit<SessionRecord, 'agent'> & {
  /** Antigravity 摘要里记录的工作区 URI；其它 CLI 通常没有。 */
  workspaceUris?: string;
};
/**
 * 列表行比 `NativeSessionSummary` 多一个可选 `cwd`，只用于归属裁决，不进入对外契约。
 *
 * 为什么不并进 `NativeSessionSummary`：`read()` 返回的 `session` 用的也是那个类型，
 * 并进去就会改变只读会话的对外形状。Claude 的老会话可能没有 cwd，这类行无法判断属于
 * 哪个项目，必须判为未归属，而不是拿「当前查的是哪个项目」的目录兜底。
 */
export type NativeSessionRow = NativeSessionSummary & { cwd?: string };
export type NativeSessionPageInput = { cursor?: string; limit: number };
export type NativeSessionPage = { items: NativeSessionRow[]; nextCursor?: string };
export type NativeSessionRead = {
  session: NativeSessionSummary;
  cwd: string;
  events: AgentEvent[];
  actualModel?: string;
};
/** 分叉只返回新会话的原生身份与目录，不复制历史为新的输入。 */
export type NativeSessionFork = Pick<NativeSessionRead, 'session' | 'cwd'>;

export type SessionProvider = {
  media?(
    id: string,
    dir: string,
    locator: NativeMediaLocator,
    signal?: AbortSignal,
  ): Promise<{ data: Buffer; mimeType: string }>;
  capabilities?: Partial<SessionCapabilities>;
  list(dir: string, signal?: AbortSignal, archived?: boolean): Promise<NativeSessionRow[]>;
  page?(
    dir: string,
    input: NativeSessionPageInput,
    signal?: AbortSignal,
    archived?: boolean,
  ): Promise<NativeSessionPage>;
  read(id: string, dir: string, signal?: AbortSignal): Promise<NativeSessionRead>;
  /** 按需读取原生子代理，保持与父会话正文、用量及分叉点分离。 */
  subagents?(id: string, dir: string, query: SubagentQuery, signal?: AbortSignal): Promise<SubagentRead>;
  /** 返回已核实的原生目录；多目录 CLI 同时保留完整归属元数据。 */
  assertBelongs(
    id: string,
    dir: string,
    signal?: AbortSignal,
  ): Promise<void | string | { cwd: string; workspaceUris: string }>;
  mutate(id: string, dir: string, input: SessionActionInput): Promise<void>;
  fork(id: string, dir: string, input: SessionForkInput): Promise<NativeSessionFork>;
};
