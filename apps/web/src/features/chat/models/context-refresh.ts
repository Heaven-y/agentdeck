import type { AgentEvent, SessionHistory } from '@agentdeck/shared/conversation';
import type { ChatState, ConversationView } from '../state/chat-state';
import { sessionsApi } from '../../sessions/api';
import { conversationBusy, conversationById, updateConversation } from '../state/conversations';

function unchanged(view: ConversationView | undefined, snapshot: ConversationView): view is ConversationView {
  return !!view && !conversationBusy(view) && !view.loadingHistory && sameRound(view, snapshot);
}

function sameRound(view: ConversationView, snapshot: ConversationView): boolean {
  return (
    view.workspaceId === snapshot.workspaceId &&
    view.agent === snapshot.agent &&
    view.sessionId === snapshot.sessionId &&
    view.conversationVersion === snapshot.conversationVersion &&
    view.lastSentAt === snapshot.lastSentAt &&
    view.runningInput === snapshot.runningInput
  );
}

/** 只补齐缺失的实时上下文；历史正文和其他元数据不进入当前时间线。 */
export function createContextRefresh(get: () => ChatState, set: (patch: Partial<ChatState>) => void) {
  const requests = new Map<string, AbortController>();
  const reported = new Map<string, string | undefined>();
  function started(view: ConversationView, turnId: string) {
    if (view.turnId === turnId) return;
    requests.get(view.conversationId)?.abort();
    reported.delete(view.conversationId);
  }
  function apply(history: SessionHistory | undefined, snapshot: ConversationView, controller: AbortController) {
    if (!history || controller.signal.aborted) return;
    if (history.session.agent !== snapshot.agent || history.session.sessionId !== snapshot.sessionId) return;
    const state = get();
    const view = conversationById(state, snapshot.conversationId);
    if (!unchanged(view, snapshot)) return;
    const context = history.events.findLast((event) => event.type === 'context');
    if (context?.type === 'context') set(updateConversation(state, view, { contextUsage: context.usage }));
  }
  async function finished(snapshot: ConversationView) {
    const hasLiveContext = reported.get(snapshot.conversationId) === snapshot.turnId;
    reported.delete(snapshot.conversationId);
    if (snapshot.agent !== 'antigravity' || !snapshot.workspaceId || !snapshot.sessionId || hasLiveContext) return;
    requests.get(snapshot.conversationId)?.abort();
    const controller = new AbortController();
    requests.set(snapshot.conversationId, controller);
    const timer = setTimeout(() => controller.abort(), 5_000);
    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      const history = await Promise.race([
        sessionsApi.sessionEvents(snapshot.workspaceId, snapshot.sessionId, snapshot.agent, controller.signal),
        cancelled,
      ]);
      apply(history, snapshot, controller);
    } catch {
      // 补读不可用不代表回合失败；保留已有上下文和实时正文。
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
      if (requests.get(snapshot.conversationId) === controller) requests.delete(snapshot.conversationId);
    }
  }
  return {
    started,
    reported(view: ConversationView, event: AgentEvent) {
      if (view.agent === 'antigravity' && event.type === 'context' && event.usage)
        reported.set(view.conversationId, view.turnId);
    },
    finished,
  };
}
