import type { FollowupSnapshot, ServerMessage } from '@agentdeck/shared/conversation';
import type { ChatState, ConversationView } from '../state/chat-state';
import type { DraftAttachment } from '../composer/attachment-actions';
import { emptyConversation, EMPTY_MODEL_OVERRIDES, DEFAULT_REASONING_EFFORTS } from '../state/chat-state-helpers';
import { conversationById, conversationViews, updateConversation } from '../state/conversations';
import { inputItem, sameDraft, restoreDraft, type LocalFollowupQueue, type FollowupDraft } from './followup-state';
import { openedTab } from '../tabs/conversation-tabs';
import { reduceChat } from '../../conversation/model/conversation-events';
import { snapshotQuestions } from '../interactions/async-question-actions';
type Set = (patch: Partial<ChatState>) => void;
type Get = () => ChatState;
function snapshotView(state: ChatState, snapshot: FollowupSnapshot): ConversationView {
  const found = conversationById(state, snapshot.conversationId);
  if (found) return found;
  return {
    ...emptyConversation,
    workspaceId: snapshot.workspaceId,
    agent: snapshot.agent,
    conversationId: snapshot.conversationId,
    sessionId: snapshot.sessionId,
    conversationVersion: Date.now(),
    modelOverrides: { ...EMPTY_MODEL_OVERRIDES },
    reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS },
  };
}

/** 快照只能挂到已存在的视图；同一原生会话的身份可以跨 conversationId 认领。 */
function knownView(state: ChatState, snapshot: FollowupSnapshot): ConversationView | undefined {
  const byId = conversationById(state, snapshot.conversationId);
  if (byId || !snapshot.sessionId) return byId;
  return conversationViews(state).find(
    (view) =>
      view.workspaceId === snapshot.workspaceId &&
      view.agent === snapshot.agent &&
      view.sessionId === snapshot.sessionId,
  );
}

function matchesView(view: ConversationView, snapshot: Pick<FollowupSnapshot, 'workspaceId' | 'agent' | 'sessionId'>) {
  if (view.workspaceId !== snapshot.workspaceId || view.agent !== snapshot.agent) return false;
  return !view.sessionId || !snapshot.sessionId || view.sessionId === snapshot.sessionId;
}
function mergeDrafts(old: LocalFollowupQueue | undefined, snapshot: FollowupSnapshot, view: ConversationView) {
  const drafts = { ...old?.drafts };
  let clearDraft = false;
  for (const item of snapshot.items) {
    const local = drafts[item.clientMessageId];
    if (!local) continue;
    if (!local.acknowledged && ['queued', 'dispatching', 'accepted', 'unknown'].includes(item.status))
      clearDraft ||= sameDraft(view, local);
    if (['accepted', 'cancelled'].includes(item.status)) delete drafts[item.clientMessageId];
    else drafts[item.clientMessageId] = updatedDraft(local, item, snapshot.sessionId);
  }
  return { drafts, clearDraft };
}
function updatedDraft(local: FollowupDraft, item: FollowupSnapshot['items'][number], sessionId?: string) {
  return {
    ...local,
    content: item.content ?? local.content,
    text: item.content?.text ?? local.text,
    attachments: bindFiles(local.attachments, sessionId),
    acknowledged: true,
    error: undefined,
  };
}
function bindFiles(files: DraftAttachment[], sessionId?: string) {
  return files.map((entry) =>
    sessionId && entry.assetScope && !entry.assetScope.sessionId
      ? { ...entry, assetScope: { ...entry.assetScope, sessionId } }
      : entry,
  );
}
function returnedDraft(view: ConversationView, snapshot: FollowupSnapshot, pending: LocalFollowupQueue['returning']) {
  if (!pending) return {};
  const item = snapshot.items.find((entry) => entry.clientMessageId === pending.clientMessageId);
  if (!item || item.revision < pending.revision) return {};
  if (item.revision === pending.revision) return { returning: pending };
  if (item.revision !== pending.revision + 1 || item.status !== 'cancelled' || !item.returnedToDraft) return {};
  const backup = { ...pending.backup, attachments: bindFiles(pending.backup.attachments, snapshot.sessionId) };
  // 取回期间新加的附件可能还在上传，此时把取回内容留作备份，不打断现有草稿。
  const patch = view.attachmentsBusy ? { draftBackups: [...view.draftBackups, backup] } : restoreDraft(view, backup);
  return { patch };
}
export function applyFollowupSnapshot(get: Get, set: Set, snapshot: FollowupSnapshot) {
  const state = get(),
    old = state.followups[snapshot.queueId];
  if (old && (old.invalid || old.snapshot.revision > snapshot.revision)) return;
  // 没有对应视图就不能显示或操作这个队列；凭空补一条会留下无法回收的「草稿」。
  const view = knownView(state, snapshot);
  if (!view || !matchesView(view, snapshot)) return;
  const { drafts, clearDraft } = mergeDrafts(old, snapshot, view);
  const cleared = clearDraft ? { draft: '', draftAttachments: [], selectedCapability: undefined } : {};
  const returned = returnedDraft({ ...view, ...cleared }, snapshot, old?.returning);
  const patch = {
    queueId: snapshot.queueId,
    sessionId: snapshot.sessionId ?? view.sessionId,
    items: snapshotQuestions(view.items, snapshot),
    ...cleared,
    ...returned.patch,
  };
  set({
    followups: { ...state.followups, [snapshot.queueId]: { snapshot, drafts, returning: returned.returning } },
    ...updateConversation(state, view, patch),
  });
}
export function invalidateFollowups(get: Get, set: Set) {
  const clearAsset = (queue: LocalFollowupQueue): LocalFollowupQueue => ({
    ...queue,
    invalid: true,
    returning: undefined,
    error: '恢复身份已失效；请核对历史后恢复到草稿，不会自动重发。',
    drafts: Object.fromEntries(
      Object.entries(queue.drafts).map(([id, draft]) => [
        id,
        {
          ...draft,
          attachments: draft.attachments.map((item) => ({
            ...item,
            asset: undefined,
            assetOwner: undefined,
            assetScope: undefined,
            error: '连接身份已失效，请重试上传。',
          })),
        },
      ]),
    ),
  });
  set({ followups: Object.fromEntries(Object.entries(get().followups).map(([id, queue]) => [id, clearAsset(queue)])) });
}

type Started = Extract<ServerMessage, { type: 'turn.started' }>;
function validStarted(message: Started) {
  const input = message.input;
  return input &&
    input.clientTurnId === message.clientTurnId &&
    input.workspaceId === message.workspaceId &&
    input.agent === message.agent
    ? input
    : undefined;
}
function startedView(state: ChatState, message: Started, input: NonNullable<Started['input']>) {
  return snapshotView(state, {
    queueId: message.queueId ?? '',
    workspaceId: input.workspaceId,
    agent: input.agent,
    conversationId: input.conversationId ?? input.clientTurnId,
    sessionId: input.sessionId,
    revision: 0,
    paused: false,
    items: [],
  });
}
function startedPatch(
  state: ChatState,
  view: ConversationView,
  message: Started,
  input: NonNullable<Started['input']>,
): Partial<ConversationView> {
  const draft = startedDraft(state, message);
  const old = draft?.attachments.length ? view.pendingAttachmentInput : undefined;
  return {
    queueId: message.queueId,
    runningInput: input,
    sessionId: input.sessionId ?? view.sessionId,
    items: inputItem(reduceChat(view.items, { type: 'turn_end', isError: false }), input, input.clientTurnId, {
      attachments: draft?.attachments.flatMap((item) => (item.asset ? [item.asset] : [])),
    }),
    running: true,
    contextWindow: undefined,
    turnId: message.turnId,
    pendingClientTurnId: undefined,
    interruptRequested: false,
    pendingAttachmentInput: draft?.attachments.length
      ? { text: input.text, attachments: draft.attachments }
      : view.pendingAttachmentInput,
    draftBackups: old
      ? [...view.draftBackups, { id: crypto.randomUUID(), text: old.text, attachments: old.attachments }]
      : view.draftBackups,
    lastSentAt: Date.now(),
    loadingHistory: false,
  };
}
function startedDraft(state: ChatState, message: Started) {
  if (!message.queueId || !message.followupClientMessageId) return;
  return state.followups[message.queueId]?.drafts[message.followupClientMessageId];
}
export function startFollowupTurn(get: Get, set: Set, message: Started) {
  const input = validStarted(message);
  if (!input) return;
  const state = get(),
    view = startedView(state, message, input);
  if (!matchesView(view, { ...input, sessionId: input.sessionId })) return;
  if (view.receivedInputs.includes(input.clientTurnId)) return;
  if (state.conversationId === view.conversationId) state.cancelHistoryRead();
  const patch = {
    ...startedPatch(state, view, message, input),
    receivedInputs: [...view.receivedInputs, input.clientTurnId].slice(-1000),
    unread: view.conversationId !== state.conversationId || !state.conversationVisible,
  };
  set({
    ...updateConversation(state, view, conversationById(state, view.conversationId) ? patch : { ...view, ...patch }),
    tabIds: openedTab(state.tabIds, view.conversationId),
  });
}
export function followupDelivered(get: Get, set: Set, message: Extract<ServerMessage, { type: 'followup.delivered' }>) {
  const state = get();
  const view = conversationById(state, message.conversationId);
  if (
    !view ||
    view.workspaceId !== message.workspaceId ||
    view.agent !== message.agent ||
    (view.sessionId && message.sessionId && view.sessionId !== message.sessionId)
  )
    return;
  if (view.receivedInputs.includes(message.clientMessageId)) return;
  set(
    updateConversation(state, view, {
      items: inputItem(view.items, message, message.clientMessageId, {
        attachments: message.attachments,
        steeringInput: true,
      }),
      receivedInputs: [...view.receivedInputs, message.clientMessageId].slice(-1000),
      unread: view.conversationId !== state.conversationId || !state.conversationVisible,
    }),
  );
}
export function followupError(get: Get, set: Set, message: Extract<ServerMessage, { type: 'followup.error' }>) {
  const state = get(),
    queue = state.followups[message.queueId];
  if (!queue) return;
  const draft = message.clientMessageId ? queue.drafts[message.clientMessageId] : undefined;
  const drafts =
    draft && message.clientMessageId
      ? { ...queue.drafts, [message.clientMessageId]: { ...draft, error: message.message } }
      : queue.drafts;
  const returning = queue.returning?.clientMessageId === message.clientMessageId ? undefined : queue.returning;
  set({
    followups: { ...state.followups, [message.queueId]: { ...queue, drafts, returning, error: message.message } },
  });
}
