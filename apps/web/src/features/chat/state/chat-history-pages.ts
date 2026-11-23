import {
  historyTurnFailureMessage,
  preferHistoryTurnFailure,
  type HistoryTurnFragment,
  type SessionHistoryPageInfo,
} from '@agentdeck/shared/conversation';
import { reduceChat, type ChatItem } from '../../conversation/model/conversation-events';
import type { ChatState } from './chat-state';

/** 回答仍来自已加载的原生输入；未看到匹配正文时不猜测状态，也不改变发送前的原生核验。 */
export function reconcileCodexHistoryQuestions(items: ChatItem[]) {
  const answers = new Set(items.flatMap((item) => (item.kind === 'user' ? [item.text.split('\n', 1)[0]] : [])));
  return items.map((item) =>
    item.kind === 'async-question' &&
    item.status === 'open' &&
    item.historyAnswerMarker &&
    answers.has(item.historyAnswerMarker)
      ? { ...item, status: 'accepted' as const }
      : item,
  );
}

function joinFragments(older: HistoryTurnFragment, newer: HistoryTurnFragment): HistoryTurnFragment {
  return {
    failed: older.failed || newer.failed,
    cancelled: newer.cancelled ?? older.cancelled,
    omitted: older.omitted || newer.omitted,
    emptyReplyMessage: newer.emptyReplyMessage,
    failure: preferHistoryTurnFailure(older.failure, newer.failure),
    retryRecovered: older.retryRecovered && newer.retryRecovered,
    forkPoint: newer.forkPoint,
  };
}

/** 只结算跨页的那个回合；已经渲染的正文、工具和选择继续使用原有行身份。 */
export function prependHistoryPage(
  current: Pick<ChatState, 'items' | 'historyPage'>,
  older: ChatItem[],
  page: SessionHistoryPageInfo,
): Pick<ChatState, 'items' | 'historyPage'> {
  const newer = current.historyPage?.leading;
  if (!newer || !page.trailing) return { items: [...older, ...current.items], historyPage: page };
  const turn = joinFragments(page.trailing, newer);
  if (page.sameFragment) return { items: [...older, ...current.items], historyPage: { ...page, leading: turn } };
  if (turn.omitted && !turn.failure) return { items: [...older, ...current.items], historyPage: page };

  return { items: finishJoinedItems(older, current.items, turn, page.start), historyPage: page };
}

function joinedEmptyReply(items: ChatItem[], turn: HistoryTurnFragment): string | undefined {
  if (
    turn.failed ||
    turn.cancelled ||
    turn.omitted ||
    !turn.emptyReplyMessage ||
    !items.some((item) => item.kind === 'user')
  )
    return;
  return items.some((item) => item.kind === 'assistant' && item.text.trim()) ? undefined : turn.emptyReplyMessage;
}

function appendJoinedError(
  items: ChatItem[],
  turn: HistoryTurnFragment,
  message: string | undefined,
  pageStart: number,
): ChatItem[] {
  if (!message || turn.failure?.shownAtTail) return items;
  return [...items, { kind: 'error', id: `history-${pageStart}:turn-error`, message }];
}

function finishJoinedItems(older: ChatItem[], newer: ChatItem[], turn: HistoryTurnFragment, pageStart: number) {
  const start = Math.max(
    0,
    older.findLastIndex((item) => item.kind === 'user'),
  );
  const nextTurn = newer.findIndex((item) => item.kind === 'user');
  const end = nextTurn < 0 ? newer.length : nextTurn;
  const items = [...older.slice(start), ...newer.slice(0, end)];
  const failed = turn.failed || !!turn.cancelled;
  const message = historyTurnFailureMessage(turn) ?? joinedEmptyReply(items, turn);
  const withNotice = appendJoinedError(items, turn, message, pageStart);
  const finished = turn.omitted
    ? withNotice
    : reduceChat(withNotice, { type: 'turn_end', isError: failed || !!message, forkPoint: turn.forkPoint });
  const point = finished.at(-1);
  if (finished.length > withNotice.length && point?.kind === 'fork-point')
    finished[finished.length - 1] = { ...point, id: `history-fork:${point.pointId}` };
  return [...older.slice(0, start), ...finished, ...newer.slice(end)];
}
