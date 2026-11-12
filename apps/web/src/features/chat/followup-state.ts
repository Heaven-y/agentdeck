import type { AgentCapability, FollowupContent, FollowupSnapshot, ClientMessage } from '@agentdeck/shared/conversation';
import type { DraftAttachment } from './attachment-actions';
import type { ChatState, ConversationView } from './chat-state';
import type { ChatItem } from './chat-reducer';
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
  invalid?: boolean;
  error?: string;
};
export const pendingFollowups = (queue?: LocalFollowupQueue) =>
  queue?.snapshot.items.filter((item) => !['accepted', 'cancelled'].includes(item.status)) ?? [];
export function viewQueue(state: ChatState, view: ConversationView = state) {
  return view.queueId
    ? state.followups[view.queueId]
    : Object.values(state.followups).find(
        (queue) =>
          queue.snapshot.conversationId === view.conversationId &&
          queue.snapshot.workspaceId === view.workspaceId &&
          queue.snapshot.agent === view.agent,
      );
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
export function steerAvailable(state: ChatState): boolean {
  const queue = viewQueue(state);
  if (
    [
      !state.running,
      !state.turnId,
      !queue?.snapshot.canSteer,
      queue?.invalid,
      queue?.snapshot.paused,
      state.selectedCapability,
    ].some(Boolean)
  )
    return false;
  return sameSteeringSettings(state);
}
function sameSteeringSettings(state: ChatState): boolean {
  const active = state.runningInput;
  const next = {
    model: state.modelOverrides[state.agent].trim() || undefined,
    reasoningEffort: state.reasoningEfforts[state.agent].trim() || undefined,
    permission: state.permission,
  };
  return (
    !!active &&
    active.model === next.model &&
    active.reasoningEffort === next.reasoningEffort &&
    active.collaborationMode === state.collaborationMode &&
    JSON.stringify(active.permission) === JSON.stringify(next.permission)
  );
}
export function inputItem(
  items: ChatItem[],
  message: Pick<Extract<ClientMessage, { type: 'chat.send' }>, 'text' | 'selection'>,
  id: string,
  attachments?: Extract<ChatItem, { kind: 'user' }>['attachments'],
): ChatItem[] {
  if (items.some((item) => item.kind === 'user' && item.clientMessageId === id)) return items;
  return [
    ...items,
    {
      kind: 'user',
      id: `user-input:${id}`,
      clientMessageId: id,
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
