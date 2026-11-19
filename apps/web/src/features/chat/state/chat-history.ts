import type { SessionHistoryPage, SessionRef } from '@agentdeck/shared/conversation';
import { ApiError } from '../../../lib/http';
import type { ChatState } from './chat-state';
import { sessionsApi } from '../../sessions/api';
import { reduceChat } from '../../conversation/model/conversation-events';
import { retainConversation } from './conversations';
import { openedTab } from '../tabs/conversation-tabs';
import { prependHistoryPage } from './chat-history-pages';
import { permissionReadState } from './chat-permission';
import {
  emptyConversation,
  historyFailure,
  historyViewVersion,
  historyParameters,
  historyRetryItems,
  sameSession,
  nativeStatus,
  reportedModel,
  sessionActionKey,
} from './chat-state-helpers';

type Options = { preserveDraft?: boolean };
type SetState = (patch: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void;

/** 历史只加载当前视图；离开取消请求，实时回合则由 chat-events 独立路由。 */
export function createChatHistory(get: () => ChatState, set: SetState) {
  let historyRequest: AbortController | undefined;
  let olderRequest: AbortController | undefined;
  let selectionGeneration = 0;
  function changeSelection(): number {
    historyRequest?.abort();
    historyRequest = undefined;
    if (olderRequest) {
      olderRequest.abort();
      olderRequest = undefined;
      set({ loadingOlderHistory: false });
    }
    return ++selectionGeneration;
  }
  function historyIsCurrent(controller: AbortController, generation: number, workspaceId: string, session: SessionRef) {
    const current = get();
    return (
      !controller.signal.aborted &&
      generation === selectionGeneration &&
      current.workspaceId === workspaceId &&
      current.agent === session.agent &&
      current.sessionId === session.sessionId
    );
  }
  function begin(workspaceId: string, session: SessionRef, options?: Options) {
    const current = get();
    const same = sameSession(current, workspaceId, session);
    const generation = changeSelection();
    const conversationVersion = historyViewVersion(current, session, generation, options);
    const controller = new AbortController();
    const conversationId = same ? current.conversationId : crypto.randomUUID();
    historyRequest = controller;
    set({
      ...emptyConversation,
      ...historyParameters(current, session),
      items: historyRetryItems(current, session, options),
      draft: same ? current.draft : '',
      ...attachmentDraft(current, same),
      view: same ? current.view : 'chat',
      lastSentAt: same ? current.lastSentAt : undefined,
      selectedCapability: same ? current.selectedCapability : undefined,
      conversationId,
      tabIds: openedTab(current.tabIds, conversationId),
      background: same ? current.background : retainConversation(current),
      agent: session.agent,
      sessionId: session.sessionId,
      actualModel: get().sessionModels[sessionActionKey(workspaceId, session)]?.actualModel,
      loadingHistory: true,
      permissionLoading: true,
      conversationVersion,
      initialDefaultsEligible: false,
    });
    return { controller, generation };
  }
  async function read(workspaceId: string, session: SessionRef, options?: Options) {
    const { controller, generation } = begin(workspaceId, session, options);
    try {
      const [historyResult, permissionResult] = await Promise.allSettled([
        sessionsApi.sessionEvents(workspaceId, session.sessionId, session.agent, controller.signal),
        sessionsApi.sessionPermission(workspaceId, session.sessionId, session.agent, controller.signal),
      ]);
      if (!historyIsCurrent(controller, generation, workspaceId, session)) return;
      set(permissionReadState(permissionResult));
      if (historyResult.status === 'rejected') throw historyResult.reason;
      const history = historyResult.value;
      assertHistoryTarget(history, session);
      const items = historyItems(history);
      const statuses = history.events.reduce((result, event) => ({ ...result, ...nativeStatus(event) }), {});
      const actualModel = reportedModel(history.actualModel);
      set((current) => ({
        items,
        title: history.session.summary,
        loadingHistory: false,
        historyPage: history.page,
        historyReloadNeeded: false,
        historyReplayable: true,
        actualModel,
        ...statuses,
        sessionModels: {
          ...current.sessionModels,
          [sessionActionKey(workspaceId, session)]: {
            actualModel,
            nativeModel: reportedModel(history.session.nativeModel),
          },
        },
      }));
    } catch (error) {
      if (historyIsCurrent(controller, generation, workspaceId, session)) {
        set({ loadingHistory: false, ...historyFailure(session.agent, error) });
      }
    } finally {
      if (historyRequest === controller) historyRequest = undefined;
    }
  }
  async function loadOlder() {
    const state = get();
    const target = olderTarget(state);
    if (!target || olderRequest) return;
    const { workspaceId, session, start, before } = target;
    const controller = new AbortController();
    const generation = selectionGeneration;
    const current = () => historyIsCurrent(controller, generation, workspaceId, session);
    olderRequest = controller;
    set({ loadingOlderHistory: true, olderHistoryError: undefined });
    try {
      const page = await sessionsApi.olderSessionEvents(workspaceId, session.sessionId, before, controller.signal);
      if (!current()) return;
      assertHistoryTarget(page, session);
      const info = assertOlderPage(page, start, before);
      const items = historyItems(page);
      set((current) => prependHistoryPage(current, items, info));
    } catch (error) {
      if (current()) set({ olderHistoryError: olderFailure(error) });
    } finally {
      if (olderRequest === controller) {
        olderRequest = undefined;
        if (current()) set({ loadingOlderHistory: false });
      }
    }
  }
  return { changeSelection, read, loadOlder };
}

function assertHistoryTarget(history: SessionHistoryPage, session: SessionRef) {
  if (history.session.agent !== session.agent || history.session.sessionId !== session.sessionId)
    throw new Error('会话身份不匹配，未载入历史。');
}
function olderTarget(state: ChatState) {
  const { workspaceId, agent, sessionId, historyPage, loadingHistory } = state;
  if (agent !== 'antigravity' || !workspaceId || !sessionId || !historyPage?.before || loadingHistory) return;
  return { workspaceId, session: { agent, sessionId }, ...historyPage, before: historyPage.before };
}
function assertOlderPage({ page }: SessionHistoryPage, start: number, before: string) {
  if (!page || !Number.isSafeInteger(page.start) || page.start < 0 || page.start >= start || page.before === before)
    throw new Error('历史返回的分页范围不匹配，未加载此页。');
  return page;
}
function olderFailure(error: unknown) {
  const restart = error instanceof ApiError && error.code === 'session_history_changed';
  const message =
    error instanceof Error && !(error instanceof TypeError) ? error.message : '暂时无法读取更早记录，请重试。';
  return { restart, message };
}
function historyItems(history: SessionHistoryPage) {
  const items = [...history.events, { type: 'turn_end', isError: false } as const].reduce(reduceChat, []);
  const page = history.page;
  // 每页独立结算条目；为位置生成的 ID 加页前缀，绝对原生事件 ID 与媒体/分叉定位不改。
  return page ? items.map((item) => ({ ...item, id: `history-${page.start}:${item.id}` })) : items;
}

function attachmentDraft(current: ChatState, same: boolean) {
  return same
    ? {
        draftAttachments: current.draftAttachments,
        attachmentsBusy: current.attachmentsBusy,
        pendingAttachmentInput: current.pendingAttachmentInput,
        draftBackups: current.draftBackups,
        queueId: current.queueId,
        receivedInputs: current.receivedInputs,
      }
    : { draftAttachments: [], attachmentsBusy: false, pendingAttachmentInput: undefined };
}
