import { create } from 'zustand';
import type { ClientMessage, RecoveryNotice, RuntimeTasksState, ServerMessage } from '@agentdeck/shared/conversation';

type State = { runtimes: Record<string, RuntimeTasksState>; pending: string[]; error?: string };
export const useRuntimeTasks = create<State>(() => ({ runtimes: {}, pending: [] }));
let sender: ((message: ClientMessage) => boolean) | undefined;
const taskKey = (runtimeId: string, taskId: string) => `${runtimeId}:${taskId}`;
export function bindRuntimeTaskSender(send: (message: ClientMessage) => boolean): void {
  sender = send;
}
function update(states: RuntimeTasksState[]): void {
  useRuntimeTasks.setState((current) => {
    const runtimes = { ...current.runtimes };
    for (const state of states) runtimes[state.runtimeId] = state;
    return {
      runtimes,
      pending: current.pending.filter((key) => !states.some((state) => key.startsWith(`${state.runtimeId}:`))),
    };
  });
}
export function runtimeTaskMessage(message: ServerMessage): void {
  if (message.type === 'tasks.state') update([message.state]);
  if (message.type === 'task.error')
    useRuntimeTasks.setState((state) => ({
      error: message.message,
      pending: state.pending.filter((key) => key !== taskKey(message.runtimeId, message.taskId)),
    }));
}
export function runtimeTaskRecovery(notice: RecoveryNotice): void {
  if (notice.type === 'connection.tasks') update(notice.states);
  if (notice.type === 'connection.rejected')
    useRuntimeTasks.setState((state) => ({
      pending: [],
      error: notice.message,
      runtimes: Object.fromEntries(
        Object.entries(state.runtimes).map(([id, value]) => [
          id,
          {
            ...value,
            closed: true,
            tasks: value.tasks.map((task) => ({ ...task, canStop: false, status: 'unknown' as const })),
          },
        ]),
      ),
    }));
}
export function stopRuntimeTask(state: RuntimeTasksState, taskId: string): boolean {
  const latest = useRuntimeTasks.getState().runtimes[state.runtimeId];
  if (!latest || !sameRuntime(latest, state)) return false;
  state = latest;
  const task = state.tasks.find((task) => task.id === taskId),
    key = taskKey(state.runtimeId, taskId);
  if (!task?.canStop || state.closed || useRuntimeTasks.getState().pending.includes(key)) return false;
  if (
    !sender?.({
      type: 'task.stop',
      workspaceId: state.workspaceId,
      agent: state.agent,
      sessionId: state.sessionId,
      runtimeId: state.runtimeId,
      taskId,
    })
  )
    return false;
  useRuntimeTasks.setState((state) => ({ pending: [...state.pending, key], error: undefined }));
  return true;
}
function sameRuntime(left: RuntimeTasksState, right: RuntimeTasksState): boolean {
  return left.sessionId === right.sessionId && left.agent === right.agent && left.workspaceId === right.workspaceId;
}
export function runtimeTaskStopping(state: RuntimeTasksState, taskId: string, pending: string[]): boolean {
  return pending.includes(taskKey(state.runtimeId, taskId)) || state.stoppingTaskIds?.includes(taskId) === true;
}
