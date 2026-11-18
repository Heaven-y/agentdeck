import { expect, it, vi } from 'vitest';
import { ClaudeTasks } from '../../../../src/agents/claude/run/tasks';

const event = (subtype: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype,
  session_id: 'native',
  ...extra,
});
it('后台集合采用原生replace，父回合结束不清任务，停止需真实确认且不能停止其他实例任务', async () => {
  const stop = vi.fn(async () => {}),
    changes = vi.fn();
  const tasks = new ClaudeTasks({ sessionId: () => 'native', stop, changed: changes });
  tasks.observe(
    event('background_tasks_changed', {
      tasks: [
        { task_id: 'child', task_type: 'local_agent', description: '合成子任务' },
        { task_id: 'watcher', task_type: 'local_bash', description: '环境监视', ambient: true },
      ],
    }),
  );
  expect(tasks.active).toBe(true);
  expect(tasks.ownsAgent('child')).toBe(true);
  await expect(tasks.stopTask('foreign')).rejects.toThrow();
  expect(stop).not.toHaveBeenCalled();
  let stopped = false;
  const pending = tasks.stopTask('child').then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stop).toHaveBeenCalledWith('child');
  expect(stopped).toBe(false);
  tasks.observe(
    event('task_notification', {
      task_id: 'child',
      status: 'stopped',
      summary: 'private-output',
      output_file: 'private-path',
    }),
  );
  await pending;
  expect(tasks.snapshot()[0]).toMatchObject({ id: 'child', status: 'cancelled', canStop: false });
  expect(JSON.stringify(tasks.snapshot())).not.toContain('private');
  expect(tasks.active).toBe(false);
  tasks.close();
  expect(changes).toHaveBeenCalled();
});
it('缺少边缘通知时replace仍释放活动，迟到started不复活已知终态，跨session与未知结构不污染', () => {
  const tasks = new ClaudeTasks({ sessionId: () => 'native', stop: async () => {}, changed: () => {} });
  tasks.observe(
    event('background_tasks_changed', { tasks: [{ task_id: 'bash', task_type: 'local_bash', description: '等待' }] }),
  );
  tasks.observe(event('background_tasks_changed', { tasks: [] }));
  expect(tasks.active).toBe(false);
  tasks.observe(event('task_notification', { task_id: 'bash', status: 'completed' }));
  tasks.observe(
    event('task_started', { task_id: 'bash', task_type: 'local_bash', description: '迟到', is_backgrounded: true }),
  );
  tasks.observe({ ...event('background_tasks_changed', { tasks: [{ task_id: 'foreign' }] }), session_id: 'other' });
  expect(tasks.snapshot()).toHaveLength(1);
  expect(tasks.snapshot()[0]?.status).toBe('completed');
  tasks.close();
});
it('停止超时/运行失败保持真实运行状态，关闭实例收尾且迟到通知不能复活', async () => {
  vi.useFakeTimers();
  const tasks = new ClaudeTasks({ sessionId: () => 'native', stop: async () => {}, changed: () => {} });
  try {
    tasks.observe(
      event('background_tasks_changed', { tasks: [{ task_id: 'bash', task_type: 'local_bash', description: '等待' }] }),
    );
    const pending = expect(tasks.stopTask('bash')).rejects.toThrow('确认');
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    expect(tasks.active).toBe(true);
    tasks.close();
    expect(tasks.snapshot()[0]).toMatchObject({ status: 'unknown', canStop: false });
    tasks.observe(event('background_tasks_changed', { tasks: [{ task_id: 'late' }] }));
    expect(tasks.active).toBe(false);
  } finally {
    tasks.close();
    vi.useRealTimers();
  }
});
it('前台子代理身份从task_started核实，终态与新背景集合更新仍有界，非法条目不开放控制', () => {
  const tasks = new ClaudeTasks({ sessionId: () => 'native', stop: async () => {}, changed: () => {} });
  tasks.observe(
    event('task_started', {
      task_id: 'foreground',
      task_type: 'local_agent',
      is_backgrounded: false,
      description: '前台子代理',
    }),
  );
  expect(tasks.ownsAgent('foreground')).toBe(true);
  expect(tasks.snapshot()[0]!.canStop).toBe(false);
  tasks.observe(event('task_progress', { task_id: 'foreground', description: '进度' }));
  tasks.observe(event('task_updated', { task_id: 'foreground', patch: { status: 'failed' } }));
  tasks.observe(
    event('background_tasks_changed', {
      tasks: Array.from({ length: 128 }, (_, i) => ({
        task_id: `task-${i}`,
        task_type: 'local_bash',
        description: '任务',
      })),
    }),
  );
  expect(tasks.snapshot()).toHaveLength(128);
  expect(tasks.ownsAgent('foreground')).toBe(false);
  tasks.observe(event('background_tasks_changed', { tasks: [{ task_id: '', task_type: 'local_bash' }] }));
  expect(tasks.active).toBe(false);
  tasks.close();
});
it('停止RPC拒绝或实例关闭不会假报成功，迟到拒绝已消费', async () => {
  const tasks = new ClaudeTasks({
    sessionId: () => 'native',
    stop: async () => {
      throw new Error('native');
    },
    changed: () => {},
  });
  tasks.observe(event('background_tasks_changed', { tasks: [{ task_id: 'task', task_type: 'local_bash' }] }));
  await expect(tasks.stopTask('task')).rejects.toThrow('native');
  expect(tasks.active).toBe(true);
  tasks.close();
  const second = new ClaudeTasks({ sessionId: () => 'native', stop: () => new Promise(() => {}), changed: () => {} });
  second.observe(event('background_tasks_changed', { tasks: [{ task_id: 'task', task_type: 'local_bash' }] }));
  const pending = expect(second.stopTask('task')).rejects.toThrow();
  second.close();
  await pending;
});
it('达到128条终态历史后回收归属，新后台任务仍能核验并申请权限', () => {
  const released = vi.fn(),
    capacity = vi.fn();
  const tasks = new ClaudeTasks({
    sessionId: () => 'native',
    stop: async () => {},
    changed: () => {},
    released,
    capacity,
  });
  tasks.observe(
    event('background_tasks_changed', {
      tasks: Array.from({ length: 128 }, (_, i) => ({ task_id: `old-${i}`, task_type: 'local_bash' })),
    }),
  );
  tasks.observe(event('task_notification', { task_id: 'old-0', status: 'completed' }));
  tasks.observe(
    event('background_tasks_changed', {
      tasks: [{ task_id: 'new-child', task_type: 'local_agent', description: '新任务' }],
    }),
  );
  expect(tasks.snapshot()).toHaveLength(128);
  expect(tasks.ownsAgent('new-child')).toBe(true);
  expect(released).toHaveBeenCalledWith('old-0');
  expect(capacity).not.toHaveBeenCalled();
  tasks.close();
});
it('超过128条实时任务时显式报告并保守保持实例活动，完整替换列表消失后释放', () => {
  const capacity = vi.fn(),
    changed = vi.fn();
  const tasks = new ClaudeTasks({ sessionId: () => 'native', stop: async () => {}, changed, capacity });
  tasks.observe(
    event('background_tasks_changed', {
      tasks: Array.from({ length: 128 }, (_, i) => ({ task_id: `active-${i}`, task_type: 'local_bash' })),
    }),
  );
  tasks.observe(event('task_started', { task_id: 'overflow', task_type: 'local_agent', is_backgrounded: true }));
  expect(capacity).toHaveBeenCalledWith('overflow');
  expect(tasks.active).toBe(true);
  expect(tasks.warning).toContain('保守占用');
  tasks.observe(event('background_tasks_changed', { tasks: [] }));
  expect(tasks.active).toBe(false);
  expect(changed).toHaveBeenCalled();
  tasks.close();
});
