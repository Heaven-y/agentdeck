import {
  taskActive,
  type AgentKind,
  type ClientMessage,
  type RuntimeTaskSnapshot,
  type RuntimeTasksState,
} from '@agentdeck/shared/conversation';
import type { RuntimeControl } from '../agents/contracts';
import { SessionError } from '../agents/errors';
import type { Socket } from './turn-manager';

type Scope = { workspaceId: string; agent: AgentKind };
type Entry = {
  owner: Socket;
  scope: Scope;
  control: RuntimeControl;
  state: RuntimeTasksState;
  unsubscribe?: () => void;
  release?: () => void;
  stopping: Set<string>;
  error?: string;
};
const unavailable = () => new SessionError(409, 'task_unavailable', '此任务已结束或无法从当前页面操作。');
function boundedTasks(control: RuntimeControl): RuntimeTaskSnapshot[] {
  return control
    .tasks()
    .filter((task) => task.sessionId === control.sessionId)
    .slice(0, 128);
}
function runtimeActive(entry: Entry): boolean {
  return entry.control.taskActivity ?? entry.state.tasks.some(taskActive);
}
export class RuntimeTasks {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly deps: {
      acquireWorkspace?(id: string): () => void;
      send(owner: Socket, message: { type: 'tasks.state'; state: RuntimeTasksState }): void;
    },
  ) {}
  register(owner: Socket, scope: Scope, control: RuntimeControl): void {
    const previous = this.entries.get(control.instanceId);
    if (previous) {
      if (
        previous.scope.workspaceId !== scope.workspaceId ||
        previous.scope.agent !== scope.agent ||
        previous.control.sessionId !== control.sessionId ||
        (previous.owner !== owner && runtimeActive(previous))
      )
        throw unavailable();
      previous.owner = owner;
      previous.control = control;
      this.changed(previous);
      return;
    }
    if (this.entries.size >= 128) throw unavailable();
    const entry: Entry = {
      owner,
      scope,
      control,
      state: { ...scope, runtimeId: control.instanceId, sessionId: control.sessionId, tasks: [] },
      stopping: new Set(),
    };
    this.entries.set(control.instanceId, entry);
    entry.unsubscribe = control.subscribe?.(() => this.changed(entry));
    this.changed(entry);
  }
  private changed(entry: Entry): void {
    if (this.entries.get(entry.control.instanceId) !== entry) return;
    const tasks = boundedTasks(entry.control);
    entry.state = {
      ...entry.state,
      tasks: structuredClone(tasks),
      closed: entry.control.alive === false,
      error: entry.state.closed ? undefined : (entry.error ?? entry.control.taskWarning),
      stoppingTaskIds: [...entry.stopping],
    };
    this.updateLease(entry, tasks);
    this.deps.send(entry.owner, { type: 'tasks.state', state: entry.state });
    if (entry.state.closed) this.forget(entry);
  }
  private updateLease(entry: Entry, tasks: RuntimeTaskSnapshot[]) {
    if (!entry.state.closed && (entry.control.taskActivity ?? tasks.some(taskActive))) {
      entry.release ??= this.deps.acquireWorkspace?.(entry.scope.workspaceId);
      return;
    }
    entry.release?.();
    entry.release = undefined;
  }
  busy(agent: AgentKind, sessionId?: string): boolean {
    return [...this.entries.values()].some(
      (entry) =>
        entry.scope.agent === agent &&
        (!sessionId || entry.state.sessionId === sessionId) &&
        !entry.state.closed &&
        runtimeActive(entry),
    );
  }
  ownedBusy(owner: Socket, agent: AgentKind, sessionId: string): boolean {
    return [...this.entries.values()].some(
      (entry) =>
        entry.owner !== owner &&
        entry.scope.agent === agent &&
        entry.state.sessionId === sessionId &&
        !entry.state.closed &&
        runtimeActive(entry),
    );
  }
  async stop(owner: Socket, message: Extract<ClientMessage, { type: 'task.stop' }>): Promise<void> {
    const entry = this.entries.get(message.runtimeId);
    if (
      !entry ||
      entry.owner !== owner ||
      entry.scope.workspaceId !== message.workspaceId ||
      entry.scope.agent !== message.agent ||
      entry.state.sessionId !== message.sessionId
    )
      throw unavailable();
    const task = entry.control.tasks().find((task) => task.id === message.taskId);
    if (!task?.canStop || entry.stopping.has(message.taskId)) throw unavailable();
    entry.stopping.add(message.taskId);
    this.changed(entry);
    try {
      await bounded(entry.control.stopTask(message.taskId));
      entry.error = undefined;
      entry.state.error = undefined;
      this.changed(entry);
    } catch {
      entry.error = '任务可能仍在运行，请稍后重试停止。';
      entry.state = { ...entry.state, error: entry.error };
      this.deps.send(owner, { type: 'tasks.state', state: entry.state });
    } finally {
      entry.stopping.delete(message.taskId);
      this.changed(entry);
    }
  }
  private forget(entry: Entry): void {
    entry.unsubscribe?.();
    entry.release?.();
    this.entries.delete(entry.control.instanceId);
  }
  async closeOwner(owner: Socket): Promise<void> {
    const entries = [...this.entries.values()].filter((entry) => entry.owner === owner);
    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          await bounded(entry.control.close?.() ?? Promise.resolve());
        } finally {
          this.forget(entry);
        }
      }),
    );
  }
  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...new Set([...this.entries.values()].map((entry) => entry.owner))].map((owner) => this.closeOwner(owner)),
    );
  }
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), 12_000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
