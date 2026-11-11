import { expect, it, vi } from 'vitest';
import { CodexBackgroundTerminals } from '../../../src/agents/codex/background-terminals';

const terminal = (processId: string, itemId = `item-${processId}`) => ({
  processId,
  itemId,
  command: 'secret command',
  cwd: 'secret cwd',
});

it('固定绑定线程并在所有分页完整读取后才公开有限快照', async () => {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method !== 'thread/backgroundTerminals/list') return {};
    return params.cursor
      ? { data: [terminal('p2')], nextCursor: null }
      : { data: [terminal('p1')], nextCursor: 'page-2' };
  });
  const tasks = new CodexBackgroundTerminals({ threadId: 'thread-a', request });
  const snapshot = await tasks.refresh();
  expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ['thread/backgroundTerminals/list', { threadId: 'thread-a', limit: 50 }],
    ['thread/backgroundTerminals/list', { threadId: 'thread-a', limit: 50, cursor: 'page-2' }],
  ]);
  expect(snapshot).toMatchObject([
    { id: 'codex-terminal:p1', sessionId: 'thread-a', status: 'running', canStop: true, kind: 'shell' },
    { id: 'codex-terminal:p2', sessionId: 'thread-a', status: 'running', canStop: true, kind: 'shell' },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain('secret');
  tasks.close();
});

it('分页坏掉或读取失败不会清空活动快照；首次失败以不可停止等待任务占住租约', async () => {
  const request = vi.fn<(method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>>(
    async (_method, params) => {
      if (params.cursor) throw new Error('fixture read failure');
      return { data: [terminal('p1')], nextCursor: 'page-2' };
    },
  );
  const tasks = new CodexBackgroundTerminals({ threadId: 'thread-a', request });
  await expect(tasks.refresh()).rejects.toThrow();
  expect(tasks.active).toBe(true);
  expect(tasks.snapshot()[0]?.id).toMatch(/^codex-terminal-read-error:/u);
  expect(tasks.snapshot()).toMatchObject([{ status: 'waiting', canStop: false }]);
  request.mockImplementation(async (method, params) => {
    if (method !== 'thread/backgroundTerminals/list') return {};
    if (params.cursor) return { data: [], nextCursor: null };
    return { data: [terminal('p1')], nextCursor: 'page-2' };
  });
  await tasks.refresh();
  expect(tasks.snapshot()).toMatchObject([{ id: 'codex-terminal:p1', status: 'running' }]);
  request.mockImplementation(async () => {
    throw new Error('fixture read failure');
  });
  await expect(tasks.refresh()).rejects.toThrow();
  expect(tasks.snapshot()).toMatchObject([{ id: 'codex-terminal:p1', status: 'running' }]);
  expect(tasks.active).toBe(true);
  tasks.close();
});

it('拒绝terminated=false；true也必须由完整列表确认该进程已消失', async () => {
  let listed = [terminal('p1')];
  let terminated: unknown = false;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'thread/backgroundTerminals/list') {
      expect(params.threadId).toBe('thread-a');
      return { data: listed, nextCursor: null };
    }
    if (method === 'thread/backgroundTerminals/terminate') {
      expect(params).toEqual({ threadId: 'thread-a', processId: 'p1' });
      return { terminated };
    }
    return {};
  });
  const tasks = new CodexBackgroundTerminals({ threadId: 'thread-a', request });
  await tasks.refresh();
  await expect(tasks.stopTask('codex-terminal:p1')).rejects.toThrow();
  expect(request.mock.calls.filter(([method]) => method === 'thread/backgroundTerminals/list')).toHaveLength(1);
  expect(tasks.active).toBe(true);
  terminated = true;
  await expect(tasks.stopTask('codex-terminal:p1')).rejects.toThrow();
  expect(tasks.active).toBe(true);
  listed = [];
  await tasks.stopTask('codex-terminal:p1');
  expect(tasks.active).toBe(false);
  tasks.close();
});

it('clean只在空结果及完整空列表复核后成功', async () => {
  let listed = [terminal('p1')];
  let cleanResult: Record<string, unknown> = {};
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    expect(params.threadId).toBe('thread-a');
    if (method === 'thread/backgroundTerminals/list') return { data: listed, nextCursor: null };
    if (method === 'thread/backgroundTerminals/clean') return cleanResult;
    return {};
  });
  const tasks = new CodexBackgroundTerminals({ threadId: 'thread-a', request });
  await tasks.refresh();
  await expect(tasks.clean()).rejects.toThrow();
  expect(tasks.active).toBe(true);
  expect(tasks.snapshot()).toMatchObject([{ id: 'codex-terminal:p1', status: 'running' }]);
  listed = [];
  await tasks.clean();
  expect(tasks.active).toBe(false);
  cleanResult = { cleaned: true };
  await expect(tasks.clean()).rejects.toThrow();
  tasks.close();
});

it('cursor循环和关闭状态拒绝操作', async () => {
  const request = vi.fn(async () => ({ data: [terminal('p1')], nextCursor: 'same' }));
  const tasks = new CodexBackgroundTerminals({ threadId: 'thread-a', request });
  await expect(tasks.refresh()).rejects.toThrow();
  expect(tasks.snapshot()).toMatchObject([{ status: 'waiting', canStop: false }]);
  const count = request.mock.calls.length;
  tasks.close();
  await expect(tasks.refresh()).rejects.toThrow();
  await expect(tasks.clean()).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(count);
});

it('总分页预算到达上限后失败并保留不可停止的读取占位', async () => {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    const cursor = typeof params.cursor === 'string' ? params.cursor : 'first';
    return { data: [], nextCursor: `${cursor}-next` };
  });
  const tasks = new CodexBackgroundTerminals({ threadId: 'thread-a', request });
  await expect(tasks.refresh()).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(10);
  expect(tasks.snapshot()).toMatchObject([{ status: 'waiting', canStop: false }]);
  expect(tasks.active).toBe(true);
  tasks.close();
});
