import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import {
  createCodexSubagents,
  pagedCodexThread,
  createCodexSubagentMedia,
  readCodexSubagents,
  readCodexSubagentMedia,
} from '../../../../src/agents/codex/history/subagents';
import { mediaHistory, mediaResponse } from '../../../../src/agents/codex/media/media-budget';
import { SessionError } from '../../../../src/agents/errors';

const dir = path.join(tmpdir(), 'codex-subagent-project');
const activity = (id: string) => ({
  type: 'subAgentActivity',
  id: `activity-${id}`,
  agentThreadId: id,
  kind: 'completed',
});
function thread(id: string, parent?: string, items: unknown[] = []) {
  return {
    id,
    cwd: dir,
    status: { type: 'idle' },
    parentThreadId: parent ?? null,
    source: parent
      ? {
          subAgent: {
            thread_spawn: {
              parent_thread_id: parent,
              depth: parent === 'root' ? 1 : 2,
              agent_nickname: '阅读者',
              agent_role: '研究',
            },
          },
        }
      : 'cli',
    turns: [{ id: 'turn', status: 'completed', items, itemsView: 'full' }],
  };
}
function fixture() {
  const rows: Record<string, ReturnType<typeof thread>> = {
    root: thread('root', undefined, [activity('child')]),
    child: thread('child', 'root', [activity('nested'), { type: 'agentMessage', id: 'reply', text: '独立回复' }]),
    nested: thread('nested', 'child', [{ type: 'agentMessage', id: 'reply', text: '嵌套回复' }]),
  };
  const read = createCodexSubagents(async (id) => structuredClone(rows[id]!));
  return { rows, read };
}
it('从父活动核实双重关系，支持摘要、嵌套导航与独立历史', async () => {
  const { read } = fixture();
  expect(await read('root', dir, {})).toMatchObject({
    agentIds: ['child'],
    summaries: [{ agentId: 'child', parentSessionId: 'root', name: '阅读者', role: '研究' }],
  });
  expect(await read('root', dir, { parentAgentId: 'child' })).toMatchObject({
    agentIds: ['nested'],
    summaries: [{ parentAgentId: 'child' }],
  });
  const history = await read('root', dir, { agentId: 'nested', parentAgentId: 'child' });
  expect(history).toMatchObject({
    agentId: 'nested',
    parentAgentId: 'child',
    events: [{ type: 'text', delta: '嵌套回复' }, { type: 'turn_end' }],
  });
  expect(JSON.stringify(history)).not.toContain('forkPoint');
});
it.each(['wrong-parent', 'wrong-source', 'other-project', 'review', 'unknown-alias'])(
  '拒绝伪父子与内部记录：%s',
  async (mode) => {
    const { rows, read } = fixture();
    if (mode === 'wrong-parent') rows.child!.parentThreadId = 'other';
    if (mode === 'wrong-source')
      (rows.child!.source as object) = { subAgent: { thread_spawn: { parent_thread_id: 'other', depth: 1 } } };
    if (mode === 'other-project') rows.child!.cwd = path.join(dir, 'other');
    if (mode === 'review') (rows.child!.source as object) = { subAgent: 'review' };
    if (mode === 'unknown-alias')
      (rows.child!.source as object) = { subAgent: { threadSpawn: { parentThreadId: 'root' } } };
    await expect(read('root', dir, { agentId: 'child' })).rejects.toMatchObject({ status: 404 });
  },
);
it('循环和超量发现明确失败，取消后不返回迟到历史', async () => {
  const { rows, read } = fixture();
  rows.nested!.turns[0]!.items = [activity('root')];
  await expect(read('root', dir, { parentAgentId: 'missing' })).rejects.toMatchObject({
    code: 'session_history_incomplete',
  });
  rows.root!.turns[0]!.items = Array.from({ length: 130 }, (_, i) => activity(`child-${i}`));
  for (let i = 0; i < 130; i++) rows[`child-${i}`] = thread(`child-${i}`, 'root');
  await expect(read('root', dir, {})).rejects.toMatchObject({ code: 'session_history_incomplete' });
  const controller = new AbortController();
  const late = createCodexSubagents(async (id) => {
    controller.abort();
    return rows[id]!;
  });
  await expect(late('root', dir, {}, controller.signal)).rejects.toThrow();
});
it('活动子历史只展示快照，分页不产生父会话分叉点或重复统计', async () => {
  const { rows, read } = fixture();
  rows.child!.status = { type: 'active' };
  rows.child!.turns = Array.from({ length: 101 }, (_, i) => ({
    id: `turn-${i}`,
    status: 'completed',
    items: [{ type: 'agentMessage', id: `reply-${i}`, text: String(i) }],
    itemsView: 'full',
  }));
  expect(await read('root', dir, { agentId: 'child' })).toMatchObject({
    summary: { status: 'running' },
    nextCursor: '100',
  });
  const last = await read('root', dir, { agentId: 'child', cursor: '100' });
  expect(last).toMatchObject({ events: [{ type: 'text', delta: '100' }, { type: 'turn_end' }] });
  expect(last).not.toHaveProperty('nextCursor');
});
it('原生turn分页使用full与升序，先拒绝跨目录元数据并拒绝重复游标', async () => {
  const requests: Array<{ method: string; input: Record<string, unknown> }> = [];
  const client = {
    request: async (method: string, input: Record<string, unknown>) => {
      requests.push({ method, input });
      if (method === 'thread/read') return { thread: thread('root') };
      return input.cursor
        ? { data: [thread('root').turns[0]], nextCursor: null }
        : { data: [thread('root').turns[0]], nextCursor: 'native-next' };
    },
  };
  expect((await pagedCodexThread(client, 'root', { dir })).turns).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    method: 'thread/turns/list',
    input: { itemsView: 'full', sortDirection: 'asc' },
  });
  requests.length = 0;
  await expect(pagedCodexThread(client, 'root', { dir: path.join(dir, 'other') })).rejects.toMatchObject({
    status: 404,
  });
  expect(requests).toHaveLength(1);
  const repeated = {
    request: async (method: string) =>
      method === 'thread/read' ? { thread: thread('root') } : { data: [thread('root').turns[0]], nextCursor: 'same' },
  };
  await expect(pagedCodexThread(repeated, 'root', { dir })).rejects.toMatchObject({
    code: 'session_history_incomplete',
  });
});
it('子历史媒体用根会话定位并重新核实嵌套归属，分页图片仍受媒体RPC预算保护', async () => {
  const { rows, read } = fixture();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
  rows.nested!.turns[0]!.items = [
    { type: 'userMessage', id: 'image', content: [{ type: 'image', url: `data:image/png;base64,${png}` }] },
  ];
  const history = await read('root', dir, { parentAgentId: 'child', agentId: 'nested' });
  expect(history).toMatchObject({
    events: [
      { type: 'user_message', attachments: [{ locator: { sessionId: 'root', subagentId: 'nested' } }] },
      { type: 'turn_end' },
    ],
  });
  const media = createCodexSubagentMedia(async (id) => rows[id]!);
  const locator = { sessionId: 'root', subagentId: 'nested', messageId: 'image', kind: 'user' as const, index: 0 };
  expect((await media('root', dir, locator)).data.toString('base64')).toBe(png);
  rows.nested!.parentThreadId = 'forged';
  await expect(media('root', dir, locator)).rejects.toMatchObject({ status: 404 });
  expect(mediaHistory('thread/turns/list', { itemsView: 'full' })).toBe(true);
  expect(mediaResponse({ result: { data: rows.nested!.turns } })).toBe(true);
});
it('正式只读客户端关闭每次子进程，原生分页媒体超过普通RPC限额仍可展示定位', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'codex-child-reader-'));
  const command = {
    command: process.execPath,
    args: [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('./fake-subagent-server.ts', import.meta.url)),
    ],
  };
  const options = { command, env: { CODEX_HOME: cwd } };
  try {
    expect(await readCodexSubagents('root', cwd, {}, options)).toMatchObject({ agentIds: ['child'] });
    expect(
      await readCodexSubagents(
        'root',
        cwd,
        { agentId: 'child' },
        { ...options, env: { ...options.env, SUBAGENT_LARGE_PAGE: '1' } },
      ),
    ).toMatchObject({
      events: [
        { type: 'user_message', attachments: [{ locator: { sessionId: 'root', subagentId: 'child' } }] },
        { type: 'text', delta: '独立回复' },
        { type: 'turn_end' },
      ],
    });
    const locator = { sessionId: 'root', subagentId: 'child', messageId: 'image', kind: 'user' as const, index: 0 };
    expect((await readCodexSubagentMedia('root', cwd, locator, options)).mimeType).toBe('image/png');
    await expect(readCodexSubagents('root', cwd, { agentId: 'unknown' }, options)).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it.each([
  ['systemError', 'completed', 'failed'],
  ['idle', 'failed', 'failed'],
  ['idle', 'interrupted', 'cancelled'],
  ['idle', 'inProgress', 'unknown'],
])('状态%s/%s按子线程快照展示为%s', async (native, turn, status) => {
  const { rows, read } = fixture();
  rows.child!.status = { type: native };
  rows.child!.turns[0]!.status = turn!;
  expect(await read('root', dir, {})).toMatchObject({ summaries: [{ status }] });
});
it('不完整turn视图明确拒绝，工具图片单独定位且不接受不存在的item', async () => {
  const { rows, read } = fixture();
  rows.child!.turns[0]!.itemsView = 'summary';
  await expect(read('root', dir, { agentId: 'child' })).rejects.toMatchObject({ code: 'session_history_incomplete' });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
  rows.child!.turns[0]!.items = [
    {
      type: 'mcpToolCall',
      id: 'tool-image',
      result: { content: [{ type: 'image', mimeType: 'image/png', data: png }] },
    },
  ];
  const media = createCodexSubagentMedia(async (id) => rows[id]!);
  const locator = { sessionId: 'root', subagentId: 'child', messageId: 'tool-image', kind: 'tool' as const, index: 0 };
  expect((await media('root', dir, locator)).mimeType).toBe('image/png');
  await expect(media('root', dir, { ...locator, messageId: 'absent' })).rejects.toMatchObject({
    code: 'media_missing',
  });
});
it('子历史的异步问题只读展示，不能借父会话入口发送回答', async () => {
  const { rows, read } = fixture();
  rows.child!.turns[0]!.items = [
    {
      type: 'agentMessage',
      id: 'question',
      delivery: 'async',
      text: '',
      questions: [{ title: '检查哪个模块？', options: ['历史', '媒体'] }],
    },
  ];
  const history = await read('root', dir, { agentId: 'child' });
  expect(JSON.stringify(history)).toContain('检查哪个模块？');
  expect(JSON.stringify(history)).not.toContain('async_question');
});
it('超时后迟到的空目录也不能当作成功快照', async () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    const read = createCodexSubagents(async () => {
      vi.setSystemTime(now + 31_000);
      return thread('root');
    });
    await expect(read('root', dir, {})).rejects.toMatchObject({ code: 'session_history_incomplete' });
  } finally {
    vi.useRealTimers();
  }
});
function formalSiblingReader(failure?: Error) {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
  const rows = {
    root: thread('root', undefined, [activity('bad'), activity('child')]),
    bad: thread('bad', 'other'),
    child: thread('child', 'root', [activity('nested')]),
    nested: thread('nested', 'child', [
      { type: 'userMessage', id: 'image', content: [{ type: 'image', url: `data:image/png;base64,${png}` }] },
    ]),
  };
  const client = {
    request: async (method: string, input: Record<string, unknown>) => {
      const id = input.threadId as keyof typeof rows;
      if (id === 'bad' && failure) throw failure;
      return method === 'thread/read' ? { thread: rows[id] } : { data: rows[id].turns, nextCursor: null };
    },
  };
  const native = (id: string, context: Parameters<typeof pagedCodexThread>[2]) => pagedCodexThread(client, id, context);
  return { rows, read: createCodexSubagents(native), media: createCodexSubagentMedia(native) };
}
it('正式reader跳过明确失效兄弟，有效目录、嵌套正文和媒体仍严格可读', async () => {
  const { rows, read, media } = formalSiblingReader();
  expect(await read('root', dir, {})).toMatchObject({ agentIds: ['child'] });
  expect(await read('root', dir, { agentId: 'nested', parentAgentId: 'child' })).toMatchObject({ agentId: 'nested' });
  await expect(read('root', dir, { agentId: 'bad' })).rejects.toMatchObject({ code: 'session_missing' });
  const locator = { sessionId: 'root', subagentId: 'nested', messageId: 'image', index: 0, kind: 'user' as const };
  expect((await media('root', dir, locator)).mimeType).toBe('image/png');
  rows.nested.parentThreadId = 'forged';
  await expect(media('root', dir, locator)).rejects.toMatchObject({ code: 'session_missing' });
});
it('明确不存在的原生兄弟同样跳过，选它仍拒绝', async () => {
  const { read } = formalSiblingReader(new SessionError(404, 'session_missing', '合成不存在'));
  expect(await read('root', dir, { agentId: 'child' })).toMatchObject({ agentId: 'child' });
  await expect(read('root', dir, { agentId: 'bad' })).rejects.toMatchObject({ code: 'session_missing' });
});
it.each(['session_history_incomplete', 'session_runtime_failed', 'cancelled'])(
  '兄弟%s错误不能伪装为不可见而跳过',
  async (code) => {
    const failure =
      code === 'cancelled' ? new DOMException('合成取消', 'AbortError') : new SessionError(503, code, '合成失败');
    const { read, media } = formalSiblingReader(failure);
    await expect(read('root', dir, { agentId: 'child' })).rejects.toBe(failure);
    await expect(
      media('root', dir, { sessionId: 'root', subagentId: 'nested', messageId: 'image', index: 0, kind: 'user' }),
    ).rejects.toBe(failure);
  },
);
it('根记录缺失及伪装成missing的普通错误仍拒绝整次读取', async () => {
  const rootFailure = new SessionError(404, 'session_missing', '根不存在');
  const read = createCodexSubagents(async () => {
    throw rootFailure;
  });
  await expect(read('root', dir, {})).rejects.toBe(rootFailure);
  const runtime = Object.assign(new Error('普通错误不能冒充节点裁决'), { status: 404, code: 'session_missing' });
  await expect(formalSiblingReader(runtime).read('root', dir, {})).rejects.toBe(runtime);
});
