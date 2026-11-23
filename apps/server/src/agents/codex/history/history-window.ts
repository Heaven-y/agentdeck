import { NativeSessionIdSchema, type AgentEvent, type SessionHistoryPageInfo } from '@agentdeck/shared/conversation';
import { z } from 'zod';
import { mediaMissing } from '../../common/media/native-media';
import { SessionError } from '../../errors';
import { markAnsweredQuestions } from '../interaction/async-questions';
import { CodexEventMapper, codexForkPoint } from '../run/mapper';
import { CodexError, CodexRpcLimit, record, text, type RecordValue } from '../run/types';

const TURN_LIMIT = 3;
const ITEM_LIMITS = [16, 4, 1];
const NativeCursor = z.string().min(1).max(550);
const Cursor = z.strictObject({
  threadId: NativeSessionIdSchema,
  start: z.int().negative(),
  turns: NativeCursor.optional(),
  part: z.strictObject({ id: NativeSessionIdSchema, items: NativeCursor }).optional(),
});
type Position = z.infer<typeof Cursor>;
export type CodexHistoryRpc = (
  method: 'thread/turns/list' | 'thread/items/list',
  params: RecordValue,
) => Promise<RecordValue>;

function incomplete() {
  return new SessionError(503, 'session_history_page_incomplete', 'Codex 原生历史页未完整返回，请重试。');
}
function changed() {
  return new SessionError(409, 'session_history_changed', 'Codex 原生历史已变化，请重新读取最近记录。');
}
function position(threadId: string, before?: string): Position {
  if (!before) return { threadId, start: 0 };
  const parsed = parsePosition(before);
  if (!parsed || (!parsed.turns && !parsed.part))
    throw new SessionError(400, 'invalid_request', 'Codex 历史分页游标无效。');
  if (parsed.threadId !== threadId) throw changed();
  return parsed;
}
function parsePosition(before: string) {
  try {
    const result = Cursor.safeParse(JSON.parse(Buffer.from(before, 'base64url').toString('utf8')));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
function pageInfo(from: Position, turns?: string, part?: Position['part']): SessionHistoryPageInfo {
  const start = from.start;
  if (!turns && !part) return { start };
  const next = { threadId: from.threadId, start: start - 1, turns, part };
  return { start, before: Buffer.from(JSON.stringify(next)).toString('base64url') };
}

function nativePage(response: RecordValue, limit: number, previous?: string) {
  const next = response.nextCursor;
  if (!Array.isArray(response.data) || response.data.length > limit) throw incomplete();
  if (next == null) return { data: response.data.map(record), next: undefined };
  const cursor = NativeCursor.safeParse(next);
  if (!cursor.success || next === previous || !response.data.length) throw incomplete();
  return { data: response.data.map(record), next: cursor.data };
}
function assertUniqueIds(data: RecordValue[], identity = NativeSessionIdSchema) {
  const ids = new Set<unknown>();
  for (const row of data) {
    if (!identity.safeParse(row.id).success || ids.has(row.id)) throw incomplete();
    ids.add(row.id);
  }
}

async function requestTurns(read: CodexHistoryRpc, from: Position, limit: number, itemsView: 'full' | 'notLoaded') {
  const response = await read('thread/turns/list', {
    threadId: from.threadId,
    limit,
    itemsView,
    sortDirection: 'desc',
    ...(from.turns ? { cursor: from.turns } : {}),
  });
  const page = nativePage(response, limit, from.turns);
  assertUniqueIds(page.data);
  if (
    itemsView === 'full' &&
    page.data.some((turn) => !Array.isArray(turn.items) || (turn.itemsView != null && turn.itemsView !== 'full'))
  )
    throw incomplete();
  if (from.turns && !page.data.length) throw changed();
  return page;
}
function unpackItem(entry: RecordValue, turnId: string): RecordValue {
  if (entry.turnId !== turnId) throw incomplete();
  const item = record(entry.item);
  if (typeof item.type !== 'string') throw incomplete();
  return {
    ...item,
    startedAtMs: entry.startedAtMs ?? item.startedAtMs,
    completedAtMs: entry.completedAtMs ?? item.completedAtMs,
  };
}
async function requestItems(read: CodexHistoryRpc, from: Position, turnId: string, limit: number) {
  const response = await read('thread/items/list', {
    threadId: from.threadId,
    turnId,
    limit,
    sortDirection: 'desc',
    ...(from.part ? { cursor: from.part.items } : {}),
  });
  const page = nativePage(response, limit, from.part?.items);
  const data = page.data.map((entry) => unpackItem(entry, turnId));
  assertUniqueIds(data, z.string().min(1).max(512));
  if (!data.length) throw incomplete();
  return { ...page, data };
}
async function boundedItems(read: CodexHistoryRpc, from: Position, turnId: string) {
  for (const limit of ITEM_LIMITS) {
    try {
      return await requestItems(read, from, turnId, limit);
    } catch (error) {
      if (error instanceof CodexError && error.methodNotFound) return undefined;
      if (!(error instanceof CodexRpcLimit)) throw error;
    }
  }
}

function locateMedia(event: AgentEvent, turnId: string): AgentEvent {
  if ((event.type !== 'user_message' && event.type !== 'tool_result') || !event.attachments) return event;
  return {
    ...event,
    attachments: event.attachments.map((attachment) =>
      attachment.kind === 'native-image' ? { ...attachment, locator: { ...attachment.locator, turnId } } : attachment,
    ),
  };
}
function replay(mapper: CodexEventMapper, turn: RecordValue, end: boolean) {
  // 只有包含原生轮尾的页展示失败和分叉点，旧步骤页不重复。
  const events = end && codexForkPoint(turn) ? mapper.history(turn) : mapper.historyItems(turn);
  return events.map((event) => locateMedia(event, text(turn.id)));
}

function notice(from: Position, omitted: boolean): AgentEvent {
  return {
    type: 'activity',
    status: 'unknown',
    id: `codex-history-${from.start}`,
    name: omitted ? '原生回合中有内容超出读取预算或 CLI 不支持步骤分页，已跳过未读取的部分' : '此页含长回合的部分步骤',
  };
}
async function readFragment(read: CodexHistoryRpc, from: Position, mapper: CodexEventMapper) {
  const { data, next } = await requestTurns(read, from, 1, 'notLoaded');
  const turn = data[0];
  if (!turn || (from.part && turn.id !== from.part.id)) throw changed();
  const id = String(turn.id);
  const items = await boundedItems(read, from, id);
  if (!items) return { page: pageInfo(from, next), events: [notice(from, true)] };
  const part = items.next ? { id, items: items.next } : undefined;
  const page = part ? pageInfo(from, from.turns, part) : pageInfo(from, next);
  const events = replay(mapper, { ...turn, items: items.data.reverse() }, !from.part);
  return { page, events: markAnsweredQuestions([notice(from, false), ...events], true) };
}

/** 普通路径只读最近或相邻三轮；超限改小窗口，单轮超限再走原生步骤游标。 */
export async function readCodexHistoryWindow(read: CodexHistoryRpc, threadId: string, before?: string) {
  const from = position(threadId, before);
  const mapper = new CodexEventMapper({ sessionId: threadId });
  if (from.part) return readFragment(read, from, mapper);
  for (const limit of [TURN_LIMIT, 1]) {
    try {
      const { data, next } = await requestTurns(read, from, limit, 'full');
      const events = data.reverse().flatMap((turn) => replay(mapper, turn, true));
      return { page: pageInfo(from, next), events: markAnsweredQuestions(events, true) };
    } catch (error) {
      if (!(error instanceof CodexRpcLimit)) throw error;
    }
  }
  return readFragment(read, from, mapper);
}

/** 原生 item 锚点为排他定位；先找前一项，再升序读目标，不扫描本机存储或整条历史。 */
export async function readCodexHistoryItem(read: CodexHistoryRpc, threadId: string, turnId: string, id: string) {
  const after = (itemId: string) => ({ type: 'item', itemId });
  const scope = { threadId, turnId, limit: 1 };
  const previous = nativePage(
    await read('thread/items/list', {
      ...scope,
      sortDirection: 'desc',
      cursor: after(id),
    }),
    1,
  ).data[0];
  const previousId = previous ? text(unpackItem(previous, turnId).id) : undefined;
  if (previous && !previousId) throw incomplete();
  const entry = nativePage(
    await read('thread/items/list', {
      ...scope,
      sortDirection: 'asc',
      ...(previousId ? { cursor: after(previousId) } : {}),
    }),
    1,
  ).data[0];
  if (!entry) throw mediaMissing();
  const item = unpackItem(entry, turnId);
  if (item.id !== id) throw mediaMissing();
  return item;
}

/** 分叉前只遍历轻量轮头，保留旧的空闲检查；完整的回复和工具结果不参与点位核验。 */
export async function checkCodexForkTurns(
  read: CodexHistoryRpc,
  threadId: string,
  point?: string,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + 15_000;
  const seen = new Set<string>();
  let cursor: string | undefined;
  let found = point === undefined;
  for (let pages = 0; pages < 64 && Date.now() < deadline; pages++) {
    signal?.throwIfAborted();
    const { data, next } = await requestTurns(read, { threadId, start: 0, turns: cursor }, 100, 'notLoaded');
    assertIdleTurns(data);
    found ||= data.some((turn) => codexForkPoint(turn) === point);
    if (!next) return found;
    if (seen.has(next)) throw incomplete();
    seen.add(next);
    cursor = next;
  }
  throw incomplete();
}

function assertIdleTurns(turns: RecordValue[]) {
  if (turns.some((turn) => turn.status === 'inProgress'))
    throw new SessionError(409, 'session_busy', 'Codex 会话尚有未结束的轮次，请结束后再分叉');
}
