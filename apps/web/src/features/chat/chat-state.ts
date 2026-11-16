import type { PermissionSelection } from '@agentdeck/shared/conversation';
import type { InteractionAnswer } from '@agentdeck/shared/conversation';
import type {
  AgentKind,
  AgentCapability,
  ContextUsage,
  CompactionState,
  SessionActionInput,
  SessionRef,
} from '@agentdeck/shared/conversation';
import type { ProductSettings } from '@agentdeck/shared/settings';
import type { ConnectionStatus } from '../../lib/ws';
import type { ChatItem } from './chat-reducer';
import type { DraftAttachment } from './attachment-actions';
import type { ChatIdentity } from '../../lib/ws';
import type { FollowupContent, FollowupMode, AsyncQuestion } from '@agentdeck/shared/conversation';
import type { LocalFollowupQueue, DraftBackup } from './followup-state';
export type SessionOperation = { action: SessionActionInput['action'] | 'fork'; pending: boolean; error?: string };
export type ChatState = {
  followups: Record<string, LocalFollowupQueue>;
  queueId?: string;
  runningInput?: FollowupContent;
  collaborationMode?: 'default' | 'plan';
  setCollaborationMode(mode?: 'default' | 'plan'): void;
  draftBackups: DraftBackup[];
  receivedInputs: string[];
  sendFollowup(text: string, mode: FollowupMode): boolean;
  editFollowup(queueId: string, id: string, text: string): boolean;
  cancelFollowup(queueId: string, id: string): boolean;
  clearFollowups(queueId: string): boolean;
  resumeFollowups(queueId: string): boolean;
  restoreFollowup(queueId: string, id: string): void;
  discardFollowupBackup(queueId: string, id: string): void;
  restoreDraftBackup(id: string): void;
  discardDraftBackup(id: string): void;
  respondAsyncQuestion(question: AsyncQuestion, answer: InteractionAnswer): boolean;
  verifyAsyncQuestion(question: AsyncQuestion): Promise<boolean>;
  dismissAsyncQuestion(question: AsyncQuestion): void;
  nativeInteractions: ChatItem[];
  respondInteraction(id: string, answer: InteractionAnswer): boolean;
  dismissInteraction(id: string): void;
  conversationId: string;
  background: Record<string, ConversationView>;
  tabIds: string[];
  closeConversationTab(id: string): void;
  moveConversationTab(id: string, target: string): void;
  conversationVisible: boolean;
  draft: string;
  draftAttachments: DraftAttachment[];
  attachmentsBusy: boolean;
  pendingAttachmentInput?: { text: string; attachments: DraftAttachment[]; rejected?: boolean; uncertain?: boolean };
  attachmentIdentity(): ChatIdentity | undefined;
  invalidateAttachmentIdentity(): void;
  syncAttachmentIdentity(): void;
  addAttachments(files: File[]): Promise<void>;
  retryAttachments(): Promise<void>;
  removeAttachment(id: string): void;
  attachmentPreviewFailed(id: string): void;
  restoreAttachmentInput(): void;
  discardAttachmentInput(): void;
  unread: boolean;
  view: 'chat' | 'trajectory';
  setDraft(text: string): void;
  setView(view: 'chat' | 'trajectory'): void;
  openConversation(id: string): void;
  interruptConversation(id: string): void;
  connection: ConnectionStatus;
  workspaceId?: string;
  agent: AgentKind;
  sessionId?: string;
  title?: string;
  modelOverrides: Record<AgentKind, string>;
  defaults: Pick<ProductSettings, 'defaultAgent' | 'modelVisibility'>;
  initialDefaultsEligible: boolean;
  reasoningEfforts: Record<AgentKind, string>;
  permission?: PermissionSelection;
  permissionLoading: boolean;
  permissionSaving: boolean;
  permissionError?: string;
  setPermission(permission?: PermissionSelection): void;
  actualModel?: string;
  /** 仅保存本页已读取/运行的原生模型元数据，不从默认或显式选择推导。 */
  sessionModels: Record<string, { actualModel?: string; nativeModel?: string }>;
  selectedCapability?: AgentCapability;
  contextUsage?: ContextUsage | null;
  contextWindow?: { model?: string; windowTokens?: number };
  compaction?: CompactionState;
  items: ChatItem[];
  inspectedItemId?: string;
  inspectorRequest: number;
  inspectItem(id?: string): void;
  /** 网页选择代次；原生首次返回sessionId不会重建时间线。 */
  conversationVersion: number;
  running: boolean;
  /** 本页最后一次发送时间；用于运行计时和原生摘要落库前的导航。 */
  lastSentAt?: number;
  turnId?: string;
  pendingClientTurnId?: string;
  interruptRequested: boolean;
  loadingHistory: boolean;
  historyReloadNeeded: boolean;
  historyReplayable: boolean;
  historyError?: string;
  historyNotice?: string;
  banner?: string;
  sessionOperations: Record<string, SessionOperation>;
  manageSession(workspaceId: string, session: SessionRef, input: SessionActionInput): Promise<boolean>;
  selectWorkspace(id?: string, options?: { restore?: boolean }): void;
  removeWorkspace(id: string, nextId?: string): void;
  resetWorkspaceConversation(id: string, expectedVersion: number): void;
  newSession(agent?: AgentKind): void;
  setAgent(agent: AgentKind): void;
  openSession(session: SessionRef & { title?: string }, options?: { preserveDraft?: boolean }): Promise<void>;
  /** 恢复实时回合前取消旧正文请求，避免迟到历史覆盖审批与增量。 */
  cancelHistoryRead(): void;
  setModel(model: string): void;
  setDefaults(settings: ProductSettings): void;
  touchDraft(): void;
  setReasoningEffort(effort: string): void;
  selectCapability(capability?: AgentCapability): void;
  send(text: string): boolean;
  interrupt(): void;
  respondPermission(requestId: string, allow: boolean): void;
  dismissBanner(): void;
  /** 只移除提示条目；原生历史里本就没有错误条目，重新读取后自然一致。 */
  dismissNotice(id: string): void;
};

/** 只有页面选择和运行内容随会话保存，连接、配置默认与管理索引仍由宿主持有。 */
export type ConversationView = Pick<
  ChatState,
  | 'conversationId'
  | 'collaborationMode'
  | 'workspaceId'
  | 'agent'
  | 'sessionId'
  | 'title'
  | 'modelOverrides'
  | 'reasoningEfforts'
  | 'permission'
  | 'permissionLoading'
  | 'permissionSaving'
  | 'permissionError'
  | 'actualModel'
  | 'selectedCapability'
  | 'contextUsage'
  | 'contextWindow'
  | 'compaction'
  | 'items'
  | 'inspectedItemId'
  | 'conversationVersion'
  | 'running'
  | 'lastSentAt'
  | 'turnId'
  | 'pendingClientTurnId'
  | 'interruptRequested'
  | 'loadingHistory'
  | 'historyReloadNeeded'
  | 'historyReplayable'
  | 'historyError'
  | 'historyNotice'
  | 'banner'
  | 'draft'
  | 'draftAttachments'
  | 'attachmentsBusy'
  | 'pendingAttachmentInput'
  | 'unread'
  | 'view'
  | 'queueId'
  | 'runningInput'
  | 'draftBackups'
  | 'receivedInputs'
>;
