import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeControl } from '../../src/agents/contracts';
import type { RuntimeTaskSnapshot, ServerMessage } from '@agentdeck/shared/conversation';
import { RuntimeTasks } from '../../src/chat/runtime-tasks';
import { createWorkspaceActivity } from '../../src/workspaces/activity';

it('后台任务独立父回合持有工作区与维护忙碌，按原实例/页面停止；关闭不影响其他拥有者', async () => {
  const activity = createWorkspaceActivity();
  const owner = { send: vi.fn<(message: ServerMessage) => void>(), isOpen: () => true },
    foreign = { send: vi.fn(), isOpen: () => true };
  let tasks: RuntimeTaskSnapshot[] = [],
    notify = () => {};
  const close = vi.fn(async () => {}),
    stopTask = vi.fn(async () => {
      tasks = tasks.map((task) => ({ ...task, status: 'cancelled', canStop: false }));
      notify();
    });
  const control: RuntimeControl = {
    instanceId: randomUUID(),
    sessionId: 'native',
    alive: true,
    tasks: () => tasks,
    stopTask,
    close,
    invalidateResources: async () => {},
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
  };
  const host = new RuntimeTasks({
    acquireWorkspace: (id) => activity.acquire(id),
    send: (socket, message) => socket.send(message),
  });
  try {
    host.register(owner, { workspaceId: 'project', agent: 'claude' }, control);
    tasks = [{ id: 'bash', sessionId: 'native', status: 'running', canStop: true }];
    notify();
    expect(host.busy('claude', 'native')).toBe(true);
    await expect(activity.withIdle('project', async () => {})).rejects.toThrow();
    const message = {
      type: 'task.stop' as const,
      workspaceId: 'project',
      agent: 'claude' as const,
      sessionId: 'native',
      runtimeId: control.instanceId,
      taskId: 'bash',
    };
    await expect(host.stop(foreign, message)).rejects.toThrow();
    expect(stopTask).not.toHaveBeenCalled();
    await host.stop(owner, message);
    expect(stopTask).toHaveBeenCalledWith('bash');
    expect(host.busy('claude')).toBe(false);
    await activity.withIdle('project', async () => {});
    tasks = [{ id: 'second', sessionId: 'native', status: 'running', canStop: true }];
    notify();
    await host.closeOwner(foreign);
    expect(close).not.toHaveBeenCalled();
    await host.closeOwner(owner);
    expect(close).toHaveBeenCalledOnce();
    expect(host.busy('claude')).toBe(false);
    await activity.withIdle('project', async () => {});
  } finally {
    await host.dispose();
  }
});
it('停止失败发布可核对状态且不释放工作区，未知owner/项目拒绝，原生关闭释放并禁止旧控制', async () => {
  const activity = createWorkspaceActivity(),
    sent: ServerMessage[] = [];
  const owner = { send: (message: ServerMessage) => sent.push(message), isOpen: () => true };
  let alive = true,
    changed = () => {};
  const close = vi.fn(async () => {
    alive = false;
    changed();
  });
  const control: RuntimeControl = {
    instanceId: randomUUID(),
    sessionId: 'native',
    get alive() {
      return alive;
    },
    tasks: () => [{ id: 'task', sessionId: 'native', status: 'running', canStop: true }],
    stopTask: async () => {
      throw new Error('private');
    },
    close,
    invalidateResources: async () => {},
    subscribe: (listener) => {
      changed = listener;
      return () => {};
    },
  };
  const host = new RuntimeTasks({
    acquireWorkspace: (id) => activity.acquire(id),
    send: (socket, message) => socket.send(message),
  });
  const message = {
    type: 'task.stop' as const,
    workspaceId: 'project',
    agent: 'claude' as const,
    sessionId: 'native',
    runtimeId: control.instanceId,
    taskId: 'task',
  };
  try {
    host.register(owner, { workspaceId: 'project', agent: 'claude' }, control);
    host.register(owner, { workspaceId: 'project', agent: 'claude' }, control);
    expect(() => host.register({ ...owner }, { workspaceId: 'project', agent: 'claude' }, control)).toThrow();
    expect(host.ownedBusy({ ...owner }, 'claude', 'native')).toBe(true);
    await expect(host.stop(owner, { ...message, workspaceId: 'other' })).rejects.toThrow();
    await host.stop(owner, message);
    expect(JSON.stringify(sent)).not.toContain('private');
    expect(sent.at(-1)).toMatchObject({
      type: 'tasks.state',
      state: { error: expect.stringContaining('可能仍在运行') },
    });
    await expect(activity.withIdle('project', async () => {})).rejects.toThrow();
    await close();
    expect(host.busy('claude')).toBe(false);
    await activity.withIdle('project', async () => {});
    await expect(host.stop(owner, message)).rejects.toThrow();
  } finally {
    await host.dispose();
  }
});
it('关闭挂起实例有时间预算，取消后的迟到结束不影响其他实例', async () => {
  vi.useFakeTimers();
  const owner = { send: vi.fn(), isOpen: () => true };
  const host = new RuntimeTasks({ send: () => {} });
  host.register(
    owner,
    { workspaceId: 'project', agent: 'codex' },
    {
      instanceId: randomUUID(),
      sessionId: 'native',
      tasks: () => [],
      stopTask: async () => {},
      invalidateResources: async () => {},
      close: () => new Promise(() => {}),
    },
  );
  const closed = host.closeOwner(owner);
  await vi.advanceTimersByTimeAsync(12_001);
  await closed;
  expect(host.busy('codex')).toBe(false);
  await host.dispose();
  vi.useRealTimers();
});
it('任务表溢出时控制层警告仍保留工作区租约，即使无法枚举溢出任务', async () => {
  const activity = createWorkspaceActivity(),
    owner = { send: vi.fn(), isOpen: () => true };
  let notify = () => {},
    active = true;
  const control: RuntimeControl = {
    instanceId: randomUUID(),
    sessionId: 'native',
    tasks: () => [],
    get taskActivity() {
      return active;
    },
    get taskWarning() {
      return active ? '容量已满，保守保持活动。' : undefined;
    },
    stopTask: async () => {},
    invalidateResources: async () => {},
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
  };
  const host = new RuntimeTasks({
    acquireWorkspace: (id) => activity.acquire(id),
    send: (socket, message) => socket.send(message),
  });
  try {
    host.register(owner, { workspaceId: 'project', agent: 'codex' }, control);
    expect(host.busy('codex', 'native')).toBe(true);
    expect(owner.send.mock.lastCall?.[0]).toMatchObject({ state: { error: '容量已满，保守保持活动。' } });
    expect(() =>
      host.register({ send: vi.fn(), isOpen: () => true }, { workspaceId: 'project', agent: 'codex' }, control),
    ).toThrow();
    expect(host.ownedBusy({ send: vi.fn(), isOpen: () => true }, 'codex', 'native')).toBe(true);
    await expect(activity.withIdle('project', async () => {})).rejects.toThrow();
    active = false;
    notify();
    expect(host.busy('codex', 'native')).toBe(false);
    await activity.withIdle('project', async () => {});
  } finally {
    await host.dispose();
  }
});
