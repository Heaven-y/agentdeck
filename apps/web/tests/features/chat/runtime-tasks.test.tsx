// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeTasksState } from '@agentdeck/shared/conversation';
import { RuntimeTasksPanel } from '../../../src/features/chat/RuntimeTasksPanel';
import {
  bindRuntimeTaskSender,
  runtimeTaskMessage,
  runtimeTaskRecovery,
  stopRuntimeTask,
  useRuntimeTasks,
} from '../../../src/features/chat/runtime-tasks-store';
const selected = { workspaceId: 'project', agent: 'codex', sessionId: 'native', connection: 'open' };
vi.mock('../../../src/features/chat/chat-store', () => ({
  useChat: (selector: (state: typeof selected) => unknown) => selector(selected),
}));
const initial: RuntimeTasksState = {
  workspaceId: 'project',
  agent: 'codex',
  sessionId: 'native',
  runtimeId: 'instance',
  tasks: [{ id: 'child', sessionId: 'native', name: '合成子代理', status: 'running', canStop: true }],
};
beforeEach(() => {
  useRuntimeTasks.setState({ runtimes: {}, pending: [], error: undefined });
  selected.sessionId = 'native';
  selected.connection = 'open';
});
afterEach(cleanup);
it('显示当前会话任务，停止携原实例身份、重复点击不重发，真实停止回执后隐藏停止按钮', () => {
  const send = vi.fn(() => true);
  bindRuntimeTaskSender(send);
  runtimeTaskMessage({ type: 'tasks.state', state: initial });
  render(<RuntimeTasksPanel />);
  fireEvent.click(screen.getByRole('button', { name: '停止任务 合成子代理' }));
  expect(send).toHaveBeenCalledWith({
    type: 'task.stop',
    workspaceId: 'project',
    agent: 'codex',
    sessionId: 'native',
    runtimeId: 'instance',
    taskId: 'child',
  });
  expect(stopRuntimeTask(initial, 'child')).toBe(false);
  expect(send).toHaveBeenCalledOnce();
  act(() =>
    runtimeTaskMessage({
      type: 'tasks.state',
      state: { ...initial, tasks: [{ ...initial.tasks[0]!, status: 'cancelled', canStop: false }] },
    }),
  );
  expect(screen.queryByRole('button', { name: '停止任务 合成子代理' })).toBeNull();
  expect(screen.getByText('已停止')).toBeTruthy();
});
it('刷新可恢复后台快照，切到其他会话不显示或控制，恢复失败后禁止再控制过期任务', () => {
  bindRuntimeTaskSender(vi.fn(() => false));
  runtimeTaskRecovery({ type: 'connection.tasks', states: [initial] });
  expect(stopRuntimeTask(initial, 'child')).toBe(false);
  selected.sessionId = 'other';
  const view = render(<RuntimeTasksPanel />);
  expect(screen.queryByText('合成子代理')).toBeNull();
  selected.sessionId = 'native';
  view.rerender(<RuntimeTasksPanel />);
  expect(screen.getByText('合成子代理')).toBeTruthy();
  act(() => runtimeTaskRecovery({ type: 'connection.rejected', code: 'owner_missing', message: '连接已失效' }));
  expect(screen.queryByRole('button', { name: '停止任务 合成子代理' })).toBeNull();
  expect(screen.getByText('状态未确认')).toBeTruthy();
  bindRuntimeTaskSender(vi.fn(() => true));
  expect(stopRuntimeTask(initial, 'child')).toBe(false);
});
