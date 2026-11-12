import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CodexTasks } from '../../../src/agents/codex/tasks';

it('只有父链发现且双parent/cwd核验通过的子轮可停止，结束后迟到消息不重新开放', async () => {
  const cwd = path.join(tmpdir(), 'agentdeck-task-codex');
  const read = vi.fn(async (id: string) => ({
    id,
    cwd,
    parentThreadId: 'root',
    source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1, agent_nickname: 'fixture' } } },
  }));
  const stop = vi.fn(async () => {}),
    tasks = new CodexTasks({ root: () => 'root', cwd, read, stop, changed: () => {} });
  tasks.notify('item/started', {
    threadId: 'root',
    item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child' },
  });
  tasks.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress' } });
  await tasks.settled();
  expect(tasks.snapshot()).toMatchObject([{ id: 'child', sessionId: 'root', status: 'running', canStop: true }]);
  expect(tasks.owns('child', 'child-turn')).toBe(true);
  expect(tasks.owns('other', 'child-turn')).toBe(false);
  await expect(tasks.stopTask('other')).rejects.toThrow();
  const pending = tasks.stopTask('child');
  await Promise.resolve();
  expect(stop).toHaveBeenCalledWith('child', 'child-turn');
  tasks.notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'interrupted' } });
  await tasks.settled();
  await pending;
  expect(tasks.active).toBe(false);
  tasks.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress' } });
  await tasks.settled();
  expect(tasks.snapshot()[0]?.canStop).toBe(false);
  tasks.close();
});

it('伪子线程、跨工作区及未知父节点不能取得任务控制，核验中仍占用活动且关闭不会复活', async () => {
  const cwd = path.join(tmpdir(), 'agentdeck-task-codex');
  let complete!: (value: Record<string, unknown>) => void;
  const read = vi.fn(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        complete = resolve;
      }),
  );
  const tasks = new CodexTasks({ root: () => 'root', cwd, read, stop: async () => {}, changed: () => {} });
  tasks.notify('item/started', { threadId: 'foreign', item: { type: 'subAgentActivity', agentThreadId: 'ignored' } });
  expect(read).not.toHaveBeenCalled();
  tasks.notify('item/started', {
    threadId: 'root',
    item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child' },
  });
  expect(tasks.active).toBe(true);
  await Promise.resolve();
  tasks.close();
  complete({
    id: 'child',
    cwd,
    parentThreadId: 'other',
    source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } },
  });
  await tasks.settled();
  expect(tasks.active).toBe(false);
  expect(tasks.owns('child')).toBe(false);
});
it('嵌套子事件先于父元数据核验返回时仍逐层核实，不能丢失后台孙任务', async () => {
  const cwd = path.join(tmpdir(), 'agentdeck-task-codex');
  const tasks = new CodexTasks({
    root: () => 'root',
    cwd,
    read: async (id) => {
      const parent = id === 'child' ? 'root' : 'child';
      return {
        id,
        cwd,
        parentThreadId: parent,
        source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: id === 'child' ? 1 : 2 } } },
      };
    },
    stop: async () => {},
    changed: () => {},
  });
  tasks.notify('item/started', {
    threadId: 'root',
    item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child' },
  });
  tasks.notify('item/started', {
    threadId: 'child',
    item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'grandchild' },
  });
  tasks.notify('turn/started', { threadId: 'grandchild', turn: { id: 'grand-turn', status: 'inProgress' } });
  await tasks.settled();
  expect(tasks.owns('grandchild', 'grand-turn')).toBe(true);
  expect(tasks.snapshot()).toHaveLength(2);
  tasks.close();
});
it('父身份不匹配拒绝整个子链，原生读取失败保持未知；停止超时不假报终态', async () => {
  const cwd = path.join(tmpdir(), 'agentdeck-task-codex');
  const read = vi.fn(async (id: string) => {
    if (id === 'unreadable') throw new Error('native');
    const parent = id === 'bad' ? 'foreign' : 'root';
    return {
      id,
      cwd,
      parentThreadId: parent,
      source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
    };
  });
  const tasks = new CodexTasks({ root: () => 'root', cwd, read, stop: async () => {}, changed: () => {} });
  for (const id of ['bad', 'unreadable', 'good'])
    tasks.notify('item/started', { threadId: 'root', item: { type: 'subAgentActivity', agentThreadId: id } });
  tasks.notify('item/started', { threadId: 'bad', item: { type: 'subAgentActivity', agentThreadId: 'bad-child' } });
  tasks.notify('turn/started', { threadId: 'good', turn: { id: 'turn' } });
  await tasks.settled();
  expect(tasks.owns('bad')).toBe(false);
  expect(read).not.toHaveBeenCalledWith('bad-child');
  expect(tasks.snapshot().find((task) => task.id === 'unreadable')?.status).toBe('waiting');
  expect(tasks.active).toBe(true);
  vi.useFakeTimers();
  try {
    const pending = expect(tasks.stopTask('good')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    expect(tasks.active).toBe(true);
  } finally {
    tasks.close();
    vi.useRealTimers();
  }
});
it('子线程暂时核验失败保守保持活动租约，有限重试成功后应用已到达的started并开放停止', async () => {
  const cwd = path.join(tmpdir(), 'agentdeck-task-retry');
  let attempts = 0;
  const capacity = vi.fn();
  const holder: { tasks?: CodexTasks } = {};
  const stop = vi.fn(async (id: string, turnId: string) => {
    holder.tasks?.notify('turn/completed', { threadId: id, turn: { id: turnId, status: 'interrupted' } });
  });
  const tasks = new CodexTasks({
    root: () => 'root',
    cwd,
    read: async (id) => {
      if (++attempts < 2) throw new Error('temporary native read failure');
      return {
        id,
        cwd,
        parentThreadId: 'root',
        source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } },
      };
    },
    stop,
    changed: () => {},
    retryDelay: async () => {},
    capacity,
  });
  holder.tasks = tasks;
  tasks.notify('item/started', { threadId: 'root', item: { type: 'subAgentActivity', agentThreadId: 'child' } });
  tasks.notify('turn/started', { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress' } });
  await tasks.settled();
  expect(attempts).toBe(2);
  expect(tasks.active).toBe(true);
  expect(tasks.snapshot()).toMatchObject([{ status: 'running', canStop: true }]);
  await tasks.stopTask('child');
  expect(stop).toHaveBeenCalledWith('child', 'child-turn');
  expect(capacity).not.toHaveBeenCalled();
  tasks.close();
});
it('完成记录从128条历史中回收，新任务仍核验并可停止；满是活动项时显式报告不静默丢弃', async () => {
  const cwd = path.join(tmpdir(), 'agentdeck-task-capacity'),
    capacity = vi.fn(),
    stopped = vi.fn();
  const holder: { tasks?: CodexTasks } = {};
  const tasks = new CodexTasks({
    root: () => 'root',
    cwd,
    read: async (id) => ({
      id,
      cwd,
      parentThreadId: 'root',
      source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } },
    }),
    stop: async (id, turnId) => {
      stopped(id);
      holder.tasks?.notify('turn/completed', { threadId: id, turn: { id: turnId, status: 'interrupted' } });
    },
    changed: () => {},
    capacity,
  });
  holder.tasks = tasks;
  for (let i = 0; i < 128; i++) {
    const id = `child-${i}`;
    tasks.notify('item/started', { threadId: 'root', item: { type: 'subAgentActivity', agentThreadId: id } });
    tasks.notify('turn/started', { threadId: id, turn: { id: `turn-${i}` } });
    tasks.notify('turn/completed', { threadId: id, turn: { id: `turn-${i}`, status: 'completed' } });
  }
  await tasks.settled();
  tasks.notify('item/started', { threadId: 'root', item: { type: 'subAgentActivity', agentThreadId: 'new-child' } });
  tasks.notify('turn/started', { threadId: 'new-child', turn: { id: 'new-turn' } });
  await tasks.settled();
  expect(tasks.snapshot()).toHaveLength(128);
  expect(tasks.snapshot().some((task) => task.id === 'new-child')).toBe(true);
  expect(tasks.snapshot().some((task) => task.id === 'child-0')).toBe(false);
  expect(tasks.owns('new-child', 'new-turn')).toBe(true);
  const pending = tasks.stopTask('new-child');
  tasks.notify('turn/completed', { threadId: 'new-child', turn: { id: 'new-turn', status: 'interrupted' } });
  await tasks.settled();
  await pending;
  expect(stopped).toHaveBeenCalledWith('new-child');
  expect(capacity).not.toHaveBeenCalled();
  tasks.close();
});
it('128个活动子线程后新登记明确报容量且租约仍活动', async () => {
  const cwd = path.join(tmpdir(), 'agentdeck-task-overflow'),
    capacity = vi.fn();
  const tasks = new CodexTasks({
    root: () => 'root',
    cwd,
    read: async (id) => ({
      id,
      cwd,
      parentThreadId: 'root',
      source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } },
    }),
    stop: async () => {},
    changed: () => {},
    capacity,
  });
  for (let i = 0; i < 128; i++) {
    const id = `active-${i}`;
    tasks.notify('item/started', { threadId: 'root', item: { type: 'subAgentActivity', agentThreadId: id } });
    tasks.notify('turn/started', { threadId: id, turn: { id: `turn-${i}` } });
  }
  tasks.notify('item/started', { threadId: 'root', item: { type: 'subAgentActivity', agentThreadId: 'overflow' } });
  await tasks.settled();
  expect(capacity).toHaveBeenCalledOnce();
  expect(tasks.snapshot()).toHaveLength(128);
  expect(tasks.active).toBe(true);
  expect(tasks.warning).toContain('保守占用');
  tasks.close();
});
