import { afterEach, expect, it, vi } from 'vitest';
import {
  readCodexHistoryItem,
  readCodexHistoryWindow,
  type CodexHistoryRpc,
} from '../../../../src/agents/codex/history/history-window';
import { CodexError, CodexRpcLimit, type RecordValue } from '../../../../src/agents/codex/run/types';
import { CodexClient } from '../../../../src/agents/codex/run/client';
import { readCodexMedia } from '../../../../src/agents/codex/history/sessions';

afterEach(() => vi.restoreAllMocks());

const threadId = 'root-history';
const turn = (id: string) => ({
  id,
  status: 'completed',
  itemsView: 'full',
  items: [{ id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: id }] }],
});
const users = (page: Awaited<ReturnType<typeof readCodexHistoryWindow>>) =>
  page.events.flatMap((event) => (event.type === 'user_message' ? [event.text] : []));

it('Codex 首屏只取三轮并反转为时间顺序；下一页使用原生游标且不可串到另一会话', async () => {
  const read = vi
    .fn<CodexHistoryRpc>()
    .mockResolvedValueOnce({
      data: ['t6', 't5', 't4'].map(turn),
      nextCursor: 'native-older',
    })
    .mockResolvedValueOnce({ data: ['t3', 't2', 't1'].map(turn), nextCursor: null });
  const latest = await readCodexHistoryWindow(read, threadId);
  expect(users(latest)).toEqual(['t4', 't5', 't6']);
  expect(latest.page).toEqual({ start: 0, before: expect.any(String) });
  await expect(readCodexHistoryWindow(read, 'other-thread', latest.page.before)).rejects.toMatchObject({
    code: 'session_history_changed',
  });
  const earlier = await readCodexHistoryWindow(read, threadId, latest.page.before);
  expect(users(earlier)).toEqual(['t1', 't2', 't3']);
  expect(earlier.page).toEqual({ start: -1 });
  expect(read.mock.calls).toEqual([
    ['thread/turns/list', { threadId, limit: 3, itemsView: 'full', sortDirection: 'desc' }],
    ['thread/turns/list', { threadId, limit: 3, itemsView: 'full', sortDirection: 'desc', cursor: 'native-older' }],
  ]);
});

it('单轮超过通信预算时接续其原生步骤页，只呈现一次原生终态，再接上前一轮', async () => {
  const metadata = { ...turn('huge-turn'), itemsView: 'notLoaded', items: [] };
  const read = vi
    .fn<CodexHistoryRpc>()
    .mockRejectedValueOnce(new CodexRpcLimit())
    .mockRejectedValueOnce(new CodexRpcLimit())
    .mockResolvedValueOnce({ data: [metadata], nextCursor: 'older-turns' })
    .mockResolvedValueOnce({
      data: [{ turnId: metadata.id, item: { id: 'reply', type: 'agentMessage', text: '尾部' } }],
      nextCursor: 'older-items',
    })
    .mockResolvedValueOnce({ data: [metadata], nextCursor: 'older-turns' })
    .mockResolvedValueOnce({ data: [{ turnId: metadata.id, item: turn('huge-turn').items[0] }], nextCursor: null })
    .mockResolvedValueOnce({ data: [turn('earlier')], nextCursor: null });
  const latest = await readCodexHistoryWindow(read, threadId);
  expect(latest.events).toContainEqual(
    expect.objectContaining({ type: 'turn_end', forkPoint: 'huge-turn', isError: false }),
  );
  const head = await readCodexHistoryWindow(read, threadId, latest.page.before);
  expect(users(head)).toEqual(['huge-turn']);
  expect(head.events.some((event) => event.type === 'turn_end')).toBe(false);
  expect(users(await readCodexHistoryWindow(read, threadId, head.page.before))).toEqual(['earlier']);
  expect(read.mock.calls.at(5)?.[1]).toMatchObject({ turnId: 'huge-turn', cursor: 'older-items' });
});

it('单个原生项目过大时明确标记未读取，不误报成功或挡住其他回合；拒绝跨轮项目', async () => {
  const metadata = { ...turn('huge-turn'), itemsView: 'notLoaded', items: [] };
  const read = vi
    .fn<CodexHistoryRpc>()
    .mockRejectedValueOnce(new CodexRpcLimit())
    .mockRejectedValueOnce(new CodexRpcLimit())
    .mockResolvedValueOnce({ data: [metadata], nextCursor: 'older-turns' })
    .mockRejectedValueOnce(new CodexRpcLimit())
    .mockRejectedValueOnce(new CodexRpcLimit())
    .mockRejectedValueOnce(new CodexRpcLimit());
  const page = await readCodexHistoryWindow(read, threadId);
  expect(page.page.before).toBeTruthy();
  expect(page.events).toEqual([expect.objectContaining({ type: 'activity', status: 'unknown' })]);
  read
    .mockRejectedValueOnce(new CodexRpcLimit())
    .mockRejectedValueOnce(new CodexRpcLimit())
    .mockResolvedValueOnce({ data: [metadata], nextCursor: 'older-turns' })
    .mockResolvedValueOnce({ data: [{ turnId: 'different', item: turn('huge-turn').items[0] }], nextCursor: null });
  await expect(readCodexHistoryWindow(read, threadId)).rejects.toMatchObject({
    code: 'session_history_page_incomplete',
  });
});

it('原生媒体只按已核实的轮次与排他锚点读目标，不把相邻条目当作图片', async () => {
  const turnId = 'media-turn';
  const previous = { id: 'previous', type: 'agentMessage' };
  const image = { id: 'image', type: 'imageView' };
  const result = (item: typeof image) => ({ data: [{ turnId, item }], nextCursor: null });
  const read = vi.fn<CodexHistoryRpc>().mockResolvedValueOnce(result(previous)).mockResolvedValueOnce(result(image));
  await expect(readCodexHistoryItem(read, threadId, turnId, image.id)).resolves.toMatchObject(image);
  expect(read.mock.calls).toEqual([
    [
      'thread/items/list',
      { threadId, turnId, limit: 1, sortDirection: 'desc', cursor: { type: 'item', itemId: image.id } },
    ],
    [
      'thread/items/list',
      { threadId, turnId, limit: 1, sortDirection: 'asc', cursor: { type: 'item', itemId: previous.id } },
    ],
  ]);
  read.mockResolvedValueOnce(result(previous)).mockResolvedValueOnce(result(previous));
  await expect(readCodexHistoryItem(read, threadId, turnId, image.id)).rejects.toMatchObject({ status: 404 });
});

it.each(['paged', 'legacy'] as const)('图片读取使用 %s 原生路径，旧版回退重新核实身份并关闭客户端', async (mode) => {
  const dir = process.cwd();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
  const image = { id: 'image', type: 'userMessage', content: [{ type: 'image', url: `data:image/png;base64,${png}` }] };
  const request = vi.fn(async (method: string, params: RecordValue) => {
    if (method === 'thread/read')
      return {
        thread: {
          id: threadId,
          cwd: dir,
          ...(params.includeTurns ? { turns: [{ ...turn('media-turn'), items: [image] }] } : {}),
        },
      };
    if (mode === 'legacy') throw new CodexError('不支持分页', false, true);
    return { data: params.sortDirection === 'desc' ? [] : [{ turnId: 'media-turn', item: image }], nextCursor: null };
  });
  const close = vi.fn(async () => {});
  vi.spyOn(CodexClient, 'start').mockResolvedValue({
    initialize: async () => {},
    request,
    close,
  } as unknown as CodexClient);
  const media = await readCodexMedia(threadId, dir, {
    sessionId: threadId,
    turnId: 'media-turn',
    messageId: 'image',
    index: 0,
    kind: 'user',
  });
  expect(media.mimeType).toBe('image/png');
  expect(media.data.toString('base64')).toBe(png);
  expect(close).toHaveBeenCalledTimes(mode === 'legacy' ? 2 : 1);
  const reads = request.mock.calls.filter(([method]) => method === 'thread/read').map(([, params]) => params);
  expect(reads).toEqual(
    mode === 'legacy'
      ? [
          { threadId, includeTurns: false },
          { threadId, includeTurns: true },
        ]
      : [{ threadId, includeTurns: false }],
  );
  expect(request.mock.calls.some(([method]) => method === 'thread/resume' || method === 'turn/start')).toBe(false);
});

it('图片条目超预算时关闭只读实例并报告失败，不能重读全量或误取相邻图片', async () => {
  const dir = process.cwd();
  const request = vi.fn(async (method: string) => {
    if (method === 'thread/read') return { thread: { id: threadId, cwd: dir } };
    throw new CodexRpcLimit();
  });
  const close = vi.fn(async () => {});
  vi.spyOn(CodexClient, 'start').mockResolvedValue({
    initialize: async () => {},
    request,
    close,
  } as unknown as CodexClient);
  await expect(
    readCodexMedia(threadId, dir, {
      sessionId: threadId,
      turnId: 'media-turn',
      messageId: 'image',
      index: 0,
      kind: 'user',
    }),
  ).rejects.toMatchObject({
    status: 503,
    code: 'session_history_page_incomplete',
  });
  expect(close).toHaveBeenCalledOnce();
  expect(request.mock.calls.map(([method]) => method)).toEqual(['thread/read', 'thread/items/list']);
});
