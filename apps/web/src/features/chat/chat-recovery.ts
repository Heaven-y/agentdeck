import type { RecoveryNotice, RecoveryTurn } from '@agentdeck/shared/conversation';
import type { ChatState, ConversationView } from './chat-state';
import { emptyConversation, DEFAULT_REASONING_EFFORTS, EMPTY_MODEL_OVERRIDES } from './chat-state-helpers';
import { conversationBusy, conversationById, conversationViews, updateConversation } from './conversations';
import { reduceChat, type ChatItem } from './chat-reducer';
import { openedTab } from './conversation-tabs';
import { preserveAttachmentInput } from './attachment-actions';
import { applyFollowupSnapshot, invalidateFollowups } from './followup-events';
import { inputItem } from './followup-state';
import { invalidateAsyncQuestions } from './async-question-actions';

type SetState = (patch: Partial<ChatState>) => void;
export const endedConversation = {
  running: false,
  turnId: undefined,
  pendingClientTurnId: undefined,
  interruptRequested: false,
};

function recoveredOptions(message: RecoveryTurn['message'], previous?: ConversationView) {
  return {
    collaborationMode: message.collaborationMode,
    modelOverrides: { ...EMPTY_MODEL_OVERRIDES, ...previous?.modelOverrides, [message.agent]: message.model ?? '' },
    reasoningEfforts: {
      ...DEFAULT_REASONING_EFFORTS,
      ...previous?.reasoningEfforts,
      [message.agent]: message.reasoningEffort ?? '',
    },
  };
}

function recoveredView(turn: RecoveryTurn, previous?: ConversationView): ConversationView {
  const { message, sentAt } = turn;
  return {
    ...emptyConversation,
    conversationId: message.conversationId ?? message.clientTurnId,
    conversationVersion: sentAt,
    ...previous,
    ...recoveredOptions(message, previous),
    workspaceId: message.workspaceId,
    agent: message.agent,
    sessionId: message.sessionId ?? previous?.sessionId,
    permission: message.permission,
    items: inputItem(previous?.items ?? [], { ...message, text: recoveredText(message) }, message.clientTurnId),
    runningInput: message,
    running: true,
    loadingHistory: false,
    permissionLoading: false,
    pendingClientTurnId: message.clientTurnId,
    lastSentAt: sentAt,
    historyNotice: '已恢复缓存中的回合；更早的原生历史尚未读取，可在本轮结束后重新读取。',
    historyReloadNeeded: true,
  };
}
function recoveredText(message: RecoveryTurn['message']): string {
  return message.text || (message.attachments?.length ? '' : '已发送原生技能或命令');
}

export function createChatRecovery(get: () => ChatState, set: SetState, interrupts: Set<string>) {
  const saved = new Map<string, RecoveryTurn>();
  function fail(view: ConversationView, message: string) {
    set(
      updateConversation(get(), view, {
        ...endedConversation,
        items: reduceChat(view.items, { type: 'turn_end', isError: true }),
        historyError: message,
        ...preserveAttachmentInput(view, true),
      }),
    );
  }
  function ready(notice: Extract<RecoveryNotice, { type: 'connection.ready' }>) {
    get().syncAttachmentIdentity();
    const accepted = new Set(notice.acceptedClientTurnIds);
    for (const view of conversationViews(get())) {
      if (view.pendingClientTurnId && !accepted.has(view.pendingClientTurnId)) {
        interrupts.delete(view.pendingClientTurnId);
        fail(view, '后端未确认收到此消息，未自动重发。请重新读取原生历史，核对后再发送。');
      } else if (conversationBusy(view)) {
        // 未确认送达的审批允许用户再次选择；已收到的最终决策在重放中保留。
        set(
          updateConversation(get(), view, {
            interruptRequested: false,
            items: view.items.map((item) =>
              (item.kind === 'permission' || item.kind === 'interaction') && !item.resolved
                ? { ...item, responding: false }
                : item,
            ),
          }),
        );
      }
    }
    saved.clear();
  }
  return {
    restore(clientTurnId: string) {
      const turn = saved.get(clientTurnId);
      if (!turn) return;
      saved.delete(clientTurnId);
      const state = get();
      if (conversationViews(state).some((view) => view.pendingClientTurnId === clientTurnId)) return;
      const id = turn.message.conversationId ?? clientTurnId;
      const view = recoveredView(turn, conversationById(state, id));
      const select = !state.items.length && !state.draft && !conversationBusy(state);
      if (select || state.conversationId === view.conversationId) state.cancelHistoryRead();
      set({
        ...(select ? view : updateConversation(state, view, view)),
        tabIds: openedTab(state.tabIds, view.conversationId),
        initialDefaultsEligible: false,
      });
    },
    onRecovery(notice: RecoveryNotice) {
      switch (notice.type) {
        case 'connection.followups':
          for (const snapshot of notice.snapshots) applyFollowupSnapshot(get, set, snapshot);
          return;
        case 'connection.snapshot':
          saved.clear();
          for (const turn of notice.turns) saved.set(turn.message.clientTurnId, turn);
          return;
        case 'connection.ready':
          return ready(notice);
        case 'connection.rejected':
          invalidateAsyncQuestions(get, set);
          invalidateFollowups(get, set);
          get().invalidateAttachmentIdentity();
          interrupts.clear();
          saved.clear();
          set({ banner: notice.message, nativeInteractions: get().nativeInteractions.map(cancelInteraction) });
          for (const view of conversationViews(get()).filter(conversationBusy)) fail(view, notice.message);
      }
    },
  };
}
function cancelInteraction(item: ChatItem): ChatItem {
  if (item.kind !== 'interaction') return item;
  if (!item.resolved || (item.interaction.kind === 'url' && item.resolved === 'submitted'))
    return { ...item, resolved: 'cancelled', responding: false };
  return item;
}
