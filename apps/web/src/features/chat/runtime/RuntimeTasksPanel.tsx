import type { RuntimeTasksState } from '@agentdeck/shared/conversation';
import { taskActive } from '@agentdeck/shared/conversation';
import { useState } from 'react';
import { buttonClass } from '../../../ui/styles';
import { useChat } from '../state/chat-store';
import { runtimeTaskStopping, stopRuntimeTask, useRuntimeTasks } from './runtime-tasks-store';

const statusText = {
  running: '运行中',
  waiting: '正在核验',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  unknown: '状态未确认',
};
export function RuntimeTasksPanel() {
  const [open, setOpen] = useState(true);
  const workspaceId = useChat((state) => state.workspaceId),
    agent = useChat((state) => state.agent),
    sessionId = useChat((state) => state.sessionId);
  const connected = useChat((state) => state.connection === 'open');
  const runtimes = useRuntimeTasks((state) => state.runtimes),
    error = useRuntimeTasks((state) => state.error);
  const states = Object.values(runtimes).filter(
    (state) =>
      state.workspaceId === workspaceId &&
      state.agent === agent &&
      state.sessionId === sessionId &&
      state.tasks.some((task) => !task.ambient),
  );
  if (!states.length) return null;
  const active = states.flatMap((state) => state.tasks).filter(taskActive).length;
  return (
    <details
      className="mx-4 mb-2 rounded-xl border border-border bg-card px-3 py-2 text-sm"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none font-medium">
        原生任务{active ? ` · ${active} 项运行中` : ''}
      </summary>
      {error && (
        <p role="alert" className="mt-2 text-xs text-warning">
          {error}
        </p>
      )}
      <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
        {states.map((state) => (
          <TaskRows key={state.runtimeId} state={state} connected={connected} />
        ))}
      </div>
    </details>
  );
}
function TaskRows({ state, connected }: { state: RuntimeTasksState; connected: boolean }) {
  const pending = useRuntimeTasks((state) => state.pending);
  return (
    <div className="space-y-2">
      {state.error && (
        <p role="alert" className="text-xs text-warning">
          {state.error}
        </p>
      )}
      {state.tasks
        .filter((task) => !task.ambient)
        .map((task) => {
          const stopping = runtimeTaskStopping(state, task.id, pending);
          return (
            <div key={task.id} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={task.name ?? task.id}>
                {task.name ?? task.id}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {stopping ? '正在停止…' : statusText[task.status]}
              </span>
              {task.canStop && !state.closed && (
                <button
                  type="button"
                  className={buttonClass('outline')}
                  disabled={!connected || stopping}
                  onClick={() => stopRuntimeTask(state, task.id)}
                  aria-label={`停止任务 ${task.name ?? task.id}`}
                >
                  停止
                </button>
              )}
            </div>
          );
        })}
    </div>
  );
}
