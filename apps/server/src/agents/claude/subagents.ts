import { getSubagentMessages, listSubagents } from '@anthropic-ai/claude-agent-sdk';
import {
  SubagentIdSchema,
  type AgentEvent,
  type SubagentQuery,
  type SubagentRead,
  type SubagentSummary,
} from '@agentdeck/shared/conversation';
import { SessionError } from '../errors';
import { subagentIncomplete, subagentMissing } from '../common/subagents';
import { ClaudeEventMapper } from './mapper';
import { claudeMediaBlock, imageSource, mediaMissing } from '../common/native-media';
import type { NativeMediaLocator } from '@agentdeck/shared/conversation';

export type ClaudeSubagentApi = {
  list(id: string, dir: string): Promise<string[]>;
  messages(id: string, agentId: string, dir: string, page: { limit: number; offset: number }): Promise<unknown[]>;
};
const nativeApi: ClaudeSubagentApi = {
  list: (id, dir) => listSubagents(id, { dir }),
  messages: (id, agentId, dir, page) => getSubagentMessages(id, agentId, { dir, ...page }),
};
const PAGE_SIZE = 100;
const MAX_REPLY_MESSAGES = 1000;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** SDK 文件读取不接受 signal：宿主停止等待后仍消费其迟到拒绝。 */
class ClaudeReadDeadline {
  private readonly deadline = Date.now() + 30_000;
  constructor(private readonly signal?: AbortSignal) {}
  check() {
    this.signal?.throwIfAborted();
    if (Date.now() >= this.deadline) throw subagentIncomplete();
  }
  async wait<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    let timer: NodeJS.Timeout | undefined;
    let abort: () => void = () => {};
    const boundary = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(subagentIncomplete()), this.deadline - Date.now());
      abort = () => {
        const reason: unknown = this.signal?.reason;
        reject(reason instanceof Error ? reason : new DOMException('子代理读取已取消。', 'AbortError'));
      };
      this.signal?.addEventListener('abort', abort, { once: true });
    });
    try {
      const operation = Promise.resolve().then(() => {
        this.check();
        return action();
      });
      const result = await Promise.race([operation, boundary]);
      this.check();
      return result;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', abort);
    }
  }
}
function boundedApi(api: ClaudeSubagentApi, deadline: ClaudeReadDeadline): ClaudeSubagentApi {
  return {
    list: (id, dir) => deadline.wait(() => api.list(id, dir)),
    messages: (id, child, dir, page) => deadline.wait(() => api.messages(id, child, dir, page)),
  };
}

function replyId(message: unknown): string | undefined {
  const wrapper = record(message);
  const inner = record(wrapper.message);
  return wrapper.type === 'assistant' && typeof inner.id === 'string' && inner.id ? inner.id : undefined;
}

/** 页尾同一 API 回复的内容块必须同行交付，否则统计和正文会在前端被分开。 */
function pageEnd(messages: unknown[]): number {
  let end = Math.min(PAGE_SIZE, messages.length);
  const nextId = replyId(messages[end]);
  if (nextId) while (end > 0 && replyId(messages[end - 1]) === nextId) end--;
  return end;
}

type PageInput = { id: string; agentId: string; dir: string; offset: number; signal?: AbortSignal };
async function completePage(api: ClaudeSubagentApi, input: PageInput) {
  const read = (limit: number) => api.messages(input.id, input.agentId, input.dir, { offset: input.offset, limit });
  let messages = await read(PAGE_SIZE + 1);
  input.signal?.throwIfAborted();
  let end = pageEnd(messages);
  if (!end && messages.length) {
    messages = await read(MAX_REPLY_MESSAGES + 1);
    input.signal?.throwIfAborted();
    const firstId = replyId(messages[0]);
    const boundary = messages.findIndex((message) => replyId(message) !== firstId);
    end = boundary < 0 ? messages.length : boundary;
    if (end > MAX_REPLY_MESSAGES)
      throw new SessionError(503, 'session_runtime_failed', '单条子代理回复过长，暂时无法读取完整历史。');
  }
  return {
    messages: messages.slice(0, end),
    ...(messages.length > end ? { nextCursor: String(input.offset + end) } : {}),
  };
}

function childEvents(messages: unknown[], id: string, agentId: string): AgentEvent[] {
  // SDK 已按子代理文件读取；解除父引用过滤只限此独立视图，不能改变主会话映射。
  const normalized = messages.map((message) => ({
    ...record(message),
    parent_tool_use_id: null,
    parent_agent_id: null,
  }));
  return new ClaudeEventMapper(id).mapHistoryBatch(normalized).map((event) => {
    if (event.type === 'turn_end') return { type: 'turn_end', isError: event.isError };
    if ((event.type === 'user_message' || event.type === 'tool_result') && event.attachments)
      return {
        ...event,
        attachments: event.attachments.map((media) =>
          media.kind === 'native-image'
            ? { ...media, locator: { ...media.locator, sessionId: id, subagentId: agentId } }
            : media,
        ),
      };
    return event;
  });
}

export function createClaudeSubagents(api: ClaudeSubagentApi = nativeApi) {
  return async (id: string, dir: string, query: SubagentQuery, signal?: AbortSignal): Promise<SubagentRead> => {
    const deadline = new ClaudeReadDeadline(signal);
    const readApi = boundedApi(api, deadline);
    const agentIds = [...new Set(await readApi.list(id, dir))].filter(
      (value) => SubagentIdSchema.safeParse(value).success,
    );
    if (agentIds.length > 128) throw subagentIncomplete();
    if (query.agentId && !agentIds.includes(query.agentId)) throw subagentMissing();
    const summaries = await claudeSummaries(readApi, { id, dir, ids: agentIds, signal });
    deadline.check();
    const visible = visibleSummaries(summaries, query);
    if (!query.agentId) return { agentIds: visible.map((summary) => summary.agentId), summaries: visible };
    const summary = visible.find((summary) => summary.agentId === query.agentId);
    if (!summary) throw subagentMissing();
    const result = await claudeChildPage(
      readApi,
      { id, dir, agentId: query.agentId, offset: Number(query.cursor ?? 0), signal },
      summary,
    );
    deadline.check();
    return result;
  };
}
function visibleSummaries(summaries: SubagentSummary[], query: SubagentQuery) {
  if (query.parentAgentId && !summaries.some((summary) => summary.agentId === query.parentAgentId))
    throw subagentMissing();
  return summaries.filter((summary) => summary.parentAgentId === query.parentAgentId);
}
async function claudeChildPage(api: ClaudeSubagentApi, input: PageInput, summary: SubagentSummary) {
  const { messages: page, nextCursor } = await completePage(api, input);
  assertMessageParents(page, summary);
  return {
    agentId: input.agentId,
    summary,
    events: childEvents(page, input.id, input.agentId),
    ...(summary.parentAgentId ? { parentAgentId: summary.parentAgentId } : {}),
    ...(nextCursor ? { nextCursor } : {}),
  };
}
function assertMessageParents(page: unknown[], summary: SubagentSummary) {
  if (page.some((message) => (record(message).parent_agent_id ?? undefined) !== summary.parentAgentId))
    throw subagentMissing();
}
async function claudeSummaries(
  api: ClaudeSubagentApi,
  input: { id: string; dir: string; ids: string[]; signal?: AbortSignal },
): Promise<SubagentSummary[]> {
  const { id, dir, ids, signal } = input;
  const summaries: SubagentSummary[] = [];
  for (const child of ids) {
    signal?.throwIfAborted();
    const first = await api.messages(id, child, dir, { offset: 0, limit: 1 });
    signal?.throwIfAborted();
    const parent = record(first[0]).parent_agent_id;
    if (parent != null && (typeof parent !== 'string' || !ids.includes(parent))) continue;
    summaries.push({
      agentId: child,
      parentSessionId: id,
      ...(typeof parent === 'string' ? { parentAgentId: parent } : {}),
      status: 'unknown',
    });
  }
  assertSummaryChains(summaries);
  return summaries;
}
function assertSummaryChains(summaries: SubagentSummary[]) {
  const byId = new Map(summaries.map((summary) => [summary.agentId, summary]));
  for (const summary of summaries) {
    const chain = new Set([summary.agentId]);
    let parent = summary.parentAgentId;
    while (parent) {
      if (chain.has(parent) || chain.size >= 10) throw subagentIncomplete();
      chain.add(parent);
      const next = byId.get(parent);
      if (!next) throw subagentMissing();
      parent = next.parentAgentId;
    }
  }
}
export function createClaudeSubagentMedia(api: ClaudeSubagentApi = nativeApi) {
  return async (id: string, dir: string, locator: NativeMediaLocator, signal?: AbortSignal) => {
    const deadline = new ClaudeReadDeadline(signal);
    const readApi = boundedApi(api, deadline);
    const child = locator.subagentId;
    if (!child) throw mediaMissing();
    const ids = [...new Set(await readApi.list(id, dir))].filter((value) => SubagentIdSchema.safeParse(value).success);
    if (ids.length > 128) throw subagentIncomplete();
    if (!ids.includes(child)) throw mediaMissing();
    const summary = (await claudeSummaries(readApi, { id, dir, ids, signal })).find(
      (summary) => summary.agentId === child,
    );
    deadline.check();
    if (!summary) throw mediaMissing();
    const result = await claudeMediaPages(readApi, { id, dir, locator, signal }, summary, deadline);
    deadline.check();
    return result;
  };
}
async function claudeMediaPages(
  api: ClaudeSubagentApi,
  input: { id: string; dir: string; locator: NativeMediaLocator; signal?: AbortSignal },
  summary: SubagentSummary,
  deadline: ClaudeReadDeadline,
) {
  const { id, dir, locator, signal } = input;
  for (let offset = 0; offset < 10_000; offset += PAGE_SIZE) {
    signal?.throwIfAborted();
    const messages = await api.messages(id, summary.agentId, dir, { offset, limit: PAGE_SIZE });
    signal?.throwIfAborted();
    deadline.check();
    assertMessageParents(messages, summary);
    try {
      return await deadline.wait(() => imageSource(claudeMediaBlock(messages, locator)));
    } catch (error) {
      if (!(error instanceof SessionError) || error.code !== 'media_missing') throw error;
    }
    if (messages.length < PAGE_SIZE) break;
  }
  throw mediaMissing();
}
