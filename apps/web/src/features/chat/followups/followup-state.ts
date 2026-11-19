import type {
  AgentCapability,
  FollowupContent,
  FollowupItem,
  FollowupSnapshot,
  ClientMessage,
} from '@agentdeck/shared/conversation';
import type { DraftAttachment } from '../composer/attachment-actions';
import type { ChatState, ConversationView } from '../state/chat-state';
import type { ChatItem } from '../../conversation/model/conversation-events';
export type DraftBackup = {
  id: string;
  text: string;
  attachments: DraftAttachment[];
  selection?: AgentCapability;
  content?: FollowupContent;
};
export type FollowupDraft = DraftBackup & { content: FollowupContent; acknowledged?: boolean; error?: string };
export type LocalFollowupQueue = {
  snapshot: FollowupSnapshot;
  drafts: Record<string, FollowupDraft>;
  returning?: { clientMessageId: string; revision: number; backup: DraftBackup };
  invalid?: boolean;
  error?: string;
};
export const pendingFollowups = (queue?: LocalFollowupQueue) =>
  queue?.snapshot.items.filter((item) => !['accepted', 'cancelled'].includes(item.status)) ?? [];
/** 队列可能早于视图的 queueId 绑定，按会话身份兜底查找；两处判定共用同一口径。 */
function findQueue(followups: ChatState['followups'], view: ConversationView) {
  return view.queueId
    ? followups[view.queueId]
    : Object.values(followups).find(
        (queue) =>
          queue.snapshot.conversationId === view.conversationId &&
          queue.snapshot.workspaceId === view.workspaceId &&
          queue.snapshot.agent === view.agent,
      );
}
/** 后台入口只在真有未完成待发项时保留；历史队列不能永久占住列表。 */
export const queueHasPending = (followups: ChatState['followups'], view: ConversationView): boolean =>
  pendingFollowups(findQueue(followups, view)).length > 0;
export function viewQueue(state: ChatState, view: ConversationView = state) {
  return findQueue(state.followups, view);
}
export function draftContent(view: ConversationView, text: string): FollowupContent {
  return {
    text,
    ...(view.draftAttachments.length
      ? {
          attachments: view.draftAttachments.flatMap((item) =>
            item.asset ? [{ id: item.asset.id, revision: item.asset.revision }] : [],
          ),
        }
      : {}),
    ...(view.selectedCapability ? { selection: { id: view.selectedCapability.id } } : {}),
    model: view.modelOverrides[view.agent].trim() || undefined,
    reasoningEffort: view.reasoningEfforts[view.agent].trim() || undefined,
    collaborationMode: view.agent === 'codex' ? view.collaborationMode : undefined,
    ...(view.permission ? { permission: view.permission } : {}),
  };
}
function questionInput(queue: LocalFollowupQueue, id: string): boolean {
  return !!queue.snapshot.questions?.some((entry) => entry.clientMessageId === id);
}
export function canReturnToDraft(item: FollowupItem, queue: LocalFollowupQueue): boolean {
  return (
    !queue.invalid &&
    item.mode === 'queue' &&
    !!item.content &&
    ['queued', 'failed'].includes(item.status) &&
    !questionInput(queue, item.clientMessageId)
  );
}
function steerTarget(state: ChatState, queue?: LocalFollowupQueue): boolean {
  return (
    state.running &&
    !!state.turnId &&
    queue?.snapshot.activeTurnId === state.turnId &&
    !!queue.snapshot.canSteer &&
    !queue.invalid &&
    !queue.snapshot.paused
  );
}
export function steerAvailable(state: ChatState): boolean {
  return (
    steerTarget(state, viewQueue(state)) &&
    !state.selectedCapability &&
    sameSteeringSettings(state.runningInput, draftContent(state, state.draft))
  );
}
export function canSteerQueued(state: ChatState, item: FollowupItem, queue: LocalFollowupQueue): boolean {
  return (
    steerTarget(state, queue) &&
    item.mode === 'queue' &&
    item.status === 'queued' &&
    !!item.content &&
    !item.content.selection &&
    !questionInput(queue, item.clientMessageId) &&
    sameSteeringSettings(state.runningInput, item.content)
  );
}
function sameSteeringSettings(active: FollowupContent | undefined, next: FollowupContent): boolean {
  return (
    !!active &&
    active.model === next.model &&
    active.reasoningEffort === next.reasoningEffort &&
    active.collaborationMode === next.collaborationMode &&
    JSON.stringify(active.permission) === JSON.stringify(next.permission)
  );
}
export function inputItem(
  items: ChatItem[],
  message: Pick<Extract<ClientMessage, { type: 'chat.send' }>, 'text' | 'selection'>,
  id: string,
  { attachments, steeringInput }: Pick<Extract<ChatItem, { kind: 'user' }>, 'attachments' | 'steeringInput'> = {},
): ChatItem[] {
  if (items.some((item) => item.kind === 'user' && item.clientMessageId === id)) return items;
  return [
    ...items,
    {
      kind: 'user',
      id: `user-input:${id}`,
      clientMessageId: id,
      ...(steeringInput ? { steeringInput } : {}),
      text: message.text || (message.selection ? `/${message.selection.id}` : ''),
      ...(attachments?.length ? { attachments } : {}),
    },
  ];
}
export function sameDraft(view: ConversationView, draft: FollowupDraft) {
  return (
    view.draft.trim() === draft.text.trim() &&
    view.selectedCapability?.id === draft.selection?.id &&
    JSON.stringify(view.draftAttachments.map((item) => item.id)) ===
      JSON.stringify(draft.attachments.map((item) => item.id))
  );
}

export function restoreDraft(view: ConversationView, saved: DraftBackup): Partial<ConversationView> {
  const current: DraftBackup = {
    id: crypto.randomUUID(),
    text: view.draft,
    attachments: view.draftAttachments,
    selection: view.selectedCapability,
    content: draftContent(view, view.draft),
  };
  return {
    draft: saved.text,
    draftAttachments: saved.attachments,
    selectedCapability: saved.selection,
    ...(saved.content
      ? {
          modelOverrides: { ...view.modelOverrides, [view.agent]: saved.content.model ?? '' },
          reasoningEfforts: { ...view.reasoningEfforts, [view.agent]: saved.content.reasoningEffort ?? '' },
          collaborationMode: saved.content.collaborationMode,
        }
      : {}),
    draftBackups: [
      ...view.draftBackups,
      ...(current.text || current.attachments.length || current.selection ? [current] : []),
    ],
  };
}
