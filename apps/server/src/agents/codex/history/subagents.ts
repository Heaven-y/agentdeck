import type { NativeMediaLocator, SubagentQuery, SubagentRead } from '@agentdeck/shared/conversation';
import { sameSessionDirectory } from '../../common/history/session-scope';
import {
  subagentEvents,
  subagentGraph,
  subagentIncomplete,
  subagentMissing,
  type SubagentNode,
  type SubagentGraphInput,
} from '../../common/history/subagents';
import { imageSource, mediaMissing } from '../../common/media/native-media';
import { CodexEventMapper } from '../run/mapper';
import { codexToolImage } from '../media/media';
import { CodexClient } from '../run/client';
import { list, record, text, type CodexRuntimeOptions, type RecordValue } from '../run/types';

type ReadContext = { dir: string; signal?: AbortSignal; parent?: SubagentNode<RecordValue> };
type ReadThread = (id: string, context: ReadContext) => Promise<RecordValue>;
const spawnSource = (value: RecordValue) => record(record(record(value.source).subAgent).thread_spawn);
const turns = (value: RecordValue) => list(value.turns).map(record);
function children(value: RecordValue) {
  return turns(value)
    .flatMap((turn) => list(turn.items).map(record))
    .filter((item) => item.type === 'subAgentActivity')
    .map((item) => ({ agentId: text(item.agentThreadId) }));
}
async function validThread(value: RecordValue, id: string, dir: string, parent?: SubagentNode<RecordValue>) {
  if (value.id !== id || !(await sameSessionDirectory(text(value.cwd), dir))) return false;
  if (!parent)
    return (
      !value.parentThreadId &&
      typeof value.source === 'string' &&
      ['cli', 'vscode', 'exec', 'appServer'].includes(value.source)
    );
  const source = spawnSource(value);
  return (
    value.parentThreadId === parent.id && source.parent_thread_id === parent.id && source.depth === parent.depth + 1
  );
}
function graph(read: ReadThread, input: SubagentGraphInput & { dir: string }) {
  const { dir, signal } = input;
  return subagentGraph(
    {
      load: (child, parent) => read(child, { dir, signal, parent }),
      validate: (value, child, parent) => validThread(value, child, dir, parent),
      children,
      status: (value) => {
        const status = text(record(value.status).type);
        if (status === 'active') return 'running';
        if (status === 'systemError') return 'failed';
        const last = turns(value).at(-1);
        if (last?.status === 'failed') return 'failed';
        if (last?.status === 'interrupted') return 'cancelled';
        return last?.status === 'completed' ? 'completed' : 'unknown';
      },
      describe: (value) => {
        const source = spawnSource(value);
        return {
          ...(text(source.agent_nickname) ? { name: text(source.agent_nickname) } : {}),
          ...(text(source.agent_role) ? { role: text(source.agent_role) } : {}),
        };
      },
    },
    input,
  );
}
export function createCodexSubagents(read: ReadThread) {
  return async (id: string, dir: string, query: SubagentQuery, signal?: AbortSignal): Promise<SubagentRead> => {
    const result = await graph(read, { id, dir, query, signal });
    if (!result.selected)
      return {
        agentIds: result.children.map((child) => child.id),
        summaries: result.children.map((child) => child.summary!),
      };
    const child = result.selected;
    const all = turns(child.value);
    if (all.some((turn) => !Array.isArray(turn.items) || (turn.itemsView !== undefined && turn.itemsView !== 'full')))
      throw subagentIncomplete();
    const offset = Number(query.cursor ?? 0);
    const page = all.slice(offset, offset + 100);
    const mapper = new CodexEventMapper({ sessionId: id });
    return {
      agentId: child.id,
      summary: child.summary,
      ...(child.summary?.parentAgentId ? { parentAgentId: child.summary.parentAgentId } : {}),
      events: subagentEvents(
        page.flatMap((turn) => mapper.history(turn)),
        id,
        child.id,
      ),
      ...(all.length > offset + page.length ? { nextCursor: String(offset + page.length) } : {}),
    };
  };
}

/** 原生分页返回完整 turn items；所有页共享总量、游标和时间预算。 */
export async function pagedCodexThread(
  client: Pick<CodexClient, 'request'>,
  id: string,
  context: ReadContext,
  directoryOnly = false,
) {
  const thread = record((await client.request('thread/read', { threadId: id, includeTurns: false })).thread);
  if (!(await validThread(thread, id, context.dir, context.parent))) throw subagentMissing();
  const all: RecordValue[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const deadline = Date.now() + 30_000;
  do {
    const page = await turnPage(client, id, { cursor, signal: context.signal });
    if (!Array.isArray(page.data)) throw subagentIncomplete();
    const projected = page.data.map(record).map((turn) =>
      directoryOnly
        ? {
            ...turn,
            items: list(turn.items)
              .map(record)
              .filter((item) => item.type === 'subAgentActivity'),
          }
        : turn,
    );
    all.push(...projected);
    cursor = nextCursor(page.nextCursor);
    if (Date.now() > deadline) throw subagentIncomplete();
    if (cursor && (cursors.has(cursor) || !page.data.length)) throw subagentIncomplete();
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { ...thread, turns: all };
}
async function turnPage(
  client: Pick<CodexClient, 'request'>,
  id: string,
  input: { cursor?: string; signal?: AbortSignal },
) {
  input.signal?.throwIfAborted();
  const result = await client.request('thread/turns/list', {
    threadId: id,
    limit: 100,
    itemsView: 'full',
    sortDirection: 'asc',
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  input.signal?.throwIfAborted();
  return result;
}
async function withReader<T>(
  dir: string,
  options: CodexRuntimeOptions & { directoryOnly?: boolean },
  action: (read: ReadThread) => Promise<T>,
) {
  const client = await CodexClient.start({ ...options, cwd: dir });
  try {
    await client.initialize();
    return await action((id, context) => pagedCodexThread(client, id, context, options.directoryOnly));
  } finally {
    await client.close();
  }
}
export function readCodexSubagents(
  id: string,
  dir: string,
  query: SubagentQuery,
  options: CodexRuntimeOptions & { directoryOnly?: boolean } = {},
) {
  return withReader(dir, options, (read) => createCodexSubagents(read)(id, dir, query, options.signal));
}
export function readCodexSubagentMedia(
  id: string,
  dir: string,
  locator: NativeMediaLocator,
  options: CodexRuntimeOptions = {},
) {
  return withReader(dir, options, (read) => createCodexSubagentMedia(read)(id, dir, locator, options.signal));
}
export function createCodexSubagentMedia(read: ReadThread) {
  return async (id: string, dir: string, locator: NativeMediaLocator, signal?: AbortSignal) => {
    if (!locator.subagentId) throw mediaMissing();
    const found = (await graph(read, { id, dir, query: {}, signal, findId: locator.subagentId })).selected;
    if (!found) throw mediaMissing();
    const item = turns(found.value)
      .flatMap((turn) => list(turn.items).map(record))
      .find((item) => item.id === locator.messageId);
    if (!item) throw mediaMissing();
    if (locator.kind === 'user' && item.type === 'userMessage') return imageSource(list(item.content)[locator.index]);
    if (locator.kind === 'tool') return codexToolImage(item, locator.index);
    throw mediaMissing();
  };
}

const nextCursor = (value: unknown) => text(value) || undefined;
