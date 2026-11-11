import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createClaudeSubagents,
  createClaudeSubagentMedia,
  type ClaudeSubagentApi,
} from '../../../src/agents/claude/subagents';
import { createClaudeSessions } from '../../../src/agents/claude/sessions';
import * as nativeMedia from '../../../src/agents/common/native-media';

const id = '11111111-1111-4111-8111-111111111111';
const dir = path.join(os.tmpdir(), 'subagent-fixture');
const message = (type: string, content: unknown, stopReason: string | null = 'end_turn') => ({
  type,
  session_id: id,
  uuid: id,
  parent_tool_use_id: 'parent-tool',
  parent_agent_id: null,
  message: { id: 'response', content, stop_reason: stopReason, usage: { input_tokens: 20, output_tokens: 5 } },
});
function setup() {
  const api = {
    list: vi.fn(async () => ['child-1', '../outside', 'child-1', 'child-2']),
    messages: vi.fn<ClaudeSubagentApi['messages']>(async () => [
      message('user', [{ type: 'text', text: '检查函数' }]),
      message('assistant', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'demo.ts' } }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'read', content: '源码' }]),
      message('assistant', [{ type: 'text', text: '检查完成' }]),
    ]),
  };
  return { api, read: createClaudeSubagents(api) };
}
describe('Claude 子代理原生历史', () => {
  it('按需枚举和读取独立记录，保留嵌套来源、工具与用量，不产生父会话分叉点', async () => {
    const { read } = setup();
    expect(await read(id, dir, {})).toMatchObject({
      agentIds: ['child-1', 'child-2'],
      summaries: [{ status: 'unknown' }, { status: 'unknown' }],
    });
    const history = await read(id, dir, { agentId: 'child-1' });
    expect(history).toMatchObject({
      agentId: 'child-1',
      events: [
        { type: 'user_message', text: '检查函数' },
        { type: 'tool_call', id: 'read' },
        { type: 'tool_result', id: 'read', output: '源码' },
        { type: 'text', delta: '检查完成' },
        { type: 'step_usage', usage: { inputTokens: 20, outputTokens: 5 } },
        { type: 'turn_end', isError: false },
      ],
    });
    if ('events' in history) expect(history.events.some((event) => 'forkPoint' in event)).toBe(false);
  });
  it('分页使用原生 offset，多读一条判定下一页，不把预算伪装为记录终点', async () => {
    const { api, read } = setup();
    api.messages.mockResolvedValue(Array.from({ length: 101 }, () => message('user', '下一条')));
    const result = await read(id, dir, { agentId: 'child-1', cursor: '100' });
    expect(api.messages).toHaveBeenCalledWith(id, 'child-1', dir, { limit: 101, offset: 100 });
    expect(result).toMatchObject({ nextCursor: '200' });
    if ('events' in result) expect(result.events).toHaveLength(100);
  });
  it('页尾跨页的同一 API 回复整体留到下页，统计只在完整正文之后', async () => {
    const { api, read } = setup();
    const first = message('assistant', [{ type: 'text', text: '第一段' }], null);
    const last = message('assistant', [{ type: 'text', text: '第二段' }]);
    const records = [...Array.from({ length: 99 }, () => message('user', '前面的消息')), first, last];
    api.messages.mockImplementation(async (_id, _agentId, _dir, page) =>
      records.slice(page.offset, page.offset + page.limit),
    );
    const page1 = await read(id, dir, { agentId: 'child-1' });
    expect(page1).toMatchObject({ nextCursor: '99' });
    if ('events' in page1) expect(page1.events).toHaveLength(99);
    const page2 = await read(id, dir, { agentId: 'child-1', cursor: '99' });
    expect(page2).not.toHaveProperty('nextCursor');
    if ('events' in page2)
      expect(page2.events.map((event) => event.type)).toEqual(['text', 'text', 'step_usage', 'turn_end']);
  });
  it('页头的单条长回复有界扩读到完整边界，游标按实际返回条数推进', async () => {
    const { api, read } = setup();
    const records = [
      ...Array.from({ length: 150 }, () => message('assistant', [{ type: 'text', text: '内容块' }])),
      message('user', '下一轮'),
    ];
    api.messages.mockImplementation(async (_id, _agentId, _dir, page) =>
      records.slice(page.offset, page.offset + page.limit),
    );
    const result = await read(id, dir, { agentId: 'child-1' });
    expect(api.messages).toHaveBeenCalledWith(id, 'child-1', dir, { offset: 0, limit: 101 });
    expect(api.messages).toHaveBeenCalledWith(id, 'child-1', dir, { offset: 0, limit: 1001 });
    expect(result).toMatchObject({ nextCursor: '150' });
    if ('events' in result) expect(result.events.filter((event) => event.type === 'text')).toHaveLength(150);
  });
  it('单条回复超过完整读取上限时明确失败，不静默截断或返回不前进的游标', async () => {
    const { api, read } = setup();
    api.messages.mockImplementation(async (_id, _agentId, _dir, page) =>
      Array.from({ length: page.limit }, () => message('assistant', [{ type: 'text', text: '内容块' }])),
    );
    await expect(read(id, dir, { agentId: 'child-1' })).rejects.toMatchObject({ status: 503 });
    expect(api.messages.mock.calls.filter((call) => call[3].limit > 1)).toHaveLength(2);
  });
  it('拒绝未枚举 ID 和取消后迟到的记录', async () => {
    const { api, read } = setup();
    await expect(read(id, dir, { agentId: '../outside' })).rejects.toMatchObject({ status: 404 });
    expect(api.messages).not.toHaveBeenCalled();
    const controller = new AbortController();
    api.list.mockImplementation(async () => {
      controller.abort();
      return ['child-1'];
    });
    await expect(read(id, dir, { agentId: 'child-1' }, controller.signal)).rejects.toThrow();
    expect(api.messages).not.toHaveBeenCalled();
  });
  it('嵌套父关系必须属于SDK同一根目录枚举，拒绝循环和伪父代理', async () => {
    const { api, read } = setup();
    api.messages.mockImplementation(async (_id, child) => [
      {
        ...message('assistant', [{ type: 'text', text: child }]),
        parent_agent_id: child === 'child-1' ? 'child-2' : null,
      },
    ]);
    expect(await read(id, dir, {})).toMatchObject({ agentIds: ['child-2'] });
    expect(await read(id, dir, { parentAgentId: 'child-2', agentId: 'child-1' })).toMatchObject({
      parentAgentId: 'child-2',
    });
    api.messages.mockResolvedValue([{ ...message('assistant', '内容'), parent_agent_id: 'unlisted' }]);
    await expect(read(id, dir, { agentId: 'child-1' })).rejects.toMatchObject({ status: 404 });
    api.messages.mockImplementation(async (_id, child) => [
      { ...message('assistant', '内容'), parent_agent_id: child === 'child-1' ? 'child-2' : 'child-1' },
    ]);
    await expect(read(id, dir, {})).rejects.toMatchObject({ code: 'session_history_incomplete' });
  });
  it('父会话目录核验失败时不触及子代理目录', async () => {
    const { api } = setup();
    const provider = createClaudeSessions(
      {
        info: async () => ({ sessionId: id, summary: '父会话', lastModified: 1, cwd: path.join(dir, 'other') }),
        list: async () => [],
        messages: async () => [],
        rename: async () => {},
        delete: async () => {},
        fork: async () => ({ sessionId: id }),
      },
      api,
    );
    await expect(provider.subagents!(id, dir, {})).rejects.toMatchObject({ status: 404 });
    expect(api.list).not.toHaveBeenCalled();
  });
  it('嵌套深度超过十层明确失败', async () => {
    const { api, read } = setup();
    api.list.mockResolvedValue(Array.from({ length: 11 }, (_, index) => `child-${index}`));
    api.messages.mockImplementation(async (_id, child) => [
      {
        ...message('user', '内容'),
        parent_agent_id: child === 'child-0' ? null : `child-${Number(child.slice(6)) - 1}`,
      },
    ]);
    await expect(read(id, dir, {})).rejects.toMatchObject({ code: 'session_history_incomplete' });
  });
  it.each(['list', 'summary', 'body'])('统一期限拒绝%s阶段最后一次迟到的成功结果', async (stage) => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const { api, read } = setup();
      api.list.mockImplementation(async () => {
        if (stage === 'list') vi.setSystemTime(started + 31_000);
        return ['child-1'];
      });
      api.messages.mockImplementation(async (_id, _child, _dir, page) => {
        if ((stage === 'summary' && page.limit === 1) || (stage === 'body' && page.limit > 1))
          vi.setSystemTime(started + 31_000);
        return [message('user', '合成内容')];
      });
      await expect(read(id, dir, stage === 'body' ? { agentId: 'child-1' } : {})).rejects.toMatchObject({
        code: 'session_history_incomplete',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('枚举、摘要与正文共用一个期限，正常预算内返回不受影响', async () => {
    vi.useFakeTimers();
    try {
      const { api, read } = setup();
      let elapsed = 0;
      const started = Date.now();
      api.list.mockImplementation(async () => {
        elapsed += 10_000;
        vi.setSystemTime(started + elapsed);
        return ['child-1'];
      });
      api.messages.mockImplementation(async () => {
        elapsed += 10_000;
        vi.setSystemTime(started + elapsed);
        return [message('user', '合成内容')];
      });
      await expect(read(id, dir, { agentId: 'child-1' })).rejects.toMatchObject({ code: 'session_history_incomplete' });
      api.list.mockResolvedValue(['child-1']);
      api.messages.mockResolvedValue([message('user', '预算内')]);
      expect(await read(id, dir, { agentId: 'child-1' })).toMatchObject({
        events: [{ type: 'user_message', text: '预算内' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('没有signal支持的SDK等待到期结束，迟到拒绝被消费；取消同样不等待SDK', async () => {
    vi.useFakeTimers();
    try {
      const { api, read } = setup();
      let rejectRead!: (reason: Error) => void;
      api.list.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectRead = reject;
          }),
      );
      const outcome = read(id, dir, {}).then(
        () => 'accepted',
        (error) => (error as { code: string }).code,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toBe('session_history_incomplete');
      rejectRead(new Error('迟到SDK拒绝'));
      await vi.advanceTimersByTimeAsync(0);
      const controller = new AbortController();
      const cancelled = read(id, dir, {}, controller.signal).then(
        () => 'accepted',
        (error) => (error as Error).message,
      );
      controller.abort(new Error('合成取消'));
      expect(await cancelled).toBe('合成取消');
      rejectRead(new Error('取消后SDK迟到拒绝'));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('媒体枚举、关系复核和内容读取共用同一期限', async () => {
    vi.useFakeTimers();
    try {
      const { api } = setup();
      let elapsed = 0;
      const started = Date.now();
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
      api.list.mockImplementation(async () => {
        elapsed += 11_000;
        vi.setSystemTime(started + elapsed);
        return ['child-1'];
      });
      api.messages.mockImplementation(async () => {
        elapsed += 11_000;
        vi.setSystemTime(started + elapsed);
        return [message('user', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }])];
      });
      const media = createClaudeSubagentMedia(api);
      await expect(
        media(id, dir, { sessionId: id, subagentId: 'child-1', messageId: id, index: 0, kind: 'user' }),
      ).rejects.toMatchObject({ code: 'session_history_incomplete' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('媒体源最后一次迟到成功仍被期限拒绝', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const decode = vi.spyOn(nativeMedia, 'imageSource').mockImplementation(async () => {
      vi.setSystemTime(started + 31_000);
      return { data: Buffer.from('合成媒体'), mimeType: 'image/png' };
    });
    try {
      const { api } = setup();
      api.list.mockResolvedValue(['child-1']);
      api.messages.mockResolvedValue([message('user', [{ type: 'image', source: { type: 'base64', data: '' } }])]);
      const read = createClaudeSubagentMedia(api);
      await expect(
        read(id, dir, { sessionId: id, subagentId: 'child-1', messageId: id, index: 0, kind: 'user' }),
      ).rejects.toMatchObject({ code: 'session_history_incomplete' });
    } finally {
      decode.mockRestore();
      vi.useRealTimers();
    }
  });
});
