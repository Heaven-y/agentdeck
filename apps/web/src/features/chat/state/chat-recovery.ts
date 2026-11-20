import type { RecoveryNotice, RecoveryTurn } from '@agentdeck/shared/conversation';
import type { ChatState, ConversationView } from './chat-state';
import { emptyConversation, DEFAULT_REASONING_EFFORTS, EMPTY_MODEL_OVERRIDES } from './chat-state-helpers';
import {
  conversationBusy,
  conversationById,
  conversationHasDraft,
  conversationViews,
  updateConversation,
} from './conversations';
import { reduceChat, type ChatItem } from '../../conversation/model/conversation-events';
import { openedTab } from '../tabs/conversation-tabs';
import { preserveAttachmentInput } from '../composer/attachment-actions';
import { applyFollowupSnapshot, invalidateFollowups } from '../followups/followup-events';
import { followupView, inputItem } from '../followups/followup-state';
import { invalidateAsyncQuestions } from '../interactions/async-question-actions';

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
    historyNotice: '已恢复本轮消息。回合结束后可加载更早的记录。',
    historyReloadNeeded: true,
  };
}
function recoveredText(message: RecoveryTurn['message']): string {
  return message.text || (message.attachments?.length ? '' : '已发送原生技能或命令');
}
function canSelectRecovered(state: ChatState) {
  return !state.items.length && !state.sessionId && !conversationHasDraft(state) && !conversationBusy(state);
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
        fail(view, '这条消息可能已发出，请重新读取会话后再决定是否发送。');
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
      const previous = followupView(state, { ...turn.message, conversationId: id });
      if (!previous && conversationById(state, id)) return;
      const view = recoveredView(turn, previous);
      const select = canSelectRecovered(state);
      if (select || state.conversationId === view.conversationId) state.cancelHistoryRead();
      const background = { ...state.background };
      delete background[view.conversationId];
      set({
        ...(select ? { ...view, background } : updateConversation(state, view, view)),
        tabIds: openedTab(state.tabIds, view.conversationId),
        initialDefaultsEligible: false,
      });
    },
    onRecovery(notice: RecoveryNotice) {
      switch (notice.type) {
        case 'connection.followups':
          for (const snapshot of notice.snapshots) applyFollowupSnapshot(get, set, snapshot, true);
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
          set({
            banner: recoveryBanner(get(), notice),
            nativeInteractions: get().nativeInteractions.map(cancelInteraction),
          });
          for (const view of conversationViews(get()).filter(conversationBusy)) fail(view, notice.message);
      }
    },
  };
}
/** 正在恢复的会话就地显示错误；空闲连接更换身份不打扰，容量阻断仍保留入口。 */
function recoveryBanner(state: ChatState, notice: Extract<RecoveryNotice, { type: 'connection.rejected' }>) {
  if (conversationBusy(state)) return;
  const pendingInteraction = state.nativeInteractions.some((item) => cancelInteraction(item) !== item);
  return notice.code === 'capacity' || pendingInteraction ? notice.message : state.banner;
}
function cancelInteraction(item: ChatItem): ChatItem {
  if (item.kind !== 'interaction') return item;
  if (!item.resolved || (item.interaction.kind === 'url' && item.resolved === 'submitted'))
    return { ...item, resolved: 'cancelled', responding: false };
  return item;
}
