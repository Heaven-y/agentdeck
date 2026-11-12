import { taskActive, type RuntimeTaskSnapshot } from '@agentdeck/shared/conversation';
import { record, text } from '../common/user-interaction-fields';
import { SessionError } from '../errors';

type Options = {
  sessionId(): string | undefined;
  stop(id: string): Promise<void>;
  changed(): void;
  released?(id: string): void;
  capacity?(id: string): void;
};
const terminal = (task: RuntimeTaskSnapshot) => ['completed', 'failed', 'cancelled'].includes(task.status);
const missing = () => new SessionError(409, 'task_unavailable', '任务已结束或不属于当前运行实例。');
/** 活动集合以原生level替换；通知仅补终态，不能用父result清掉后台任务。 */
export class ClaudeTasks {
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  private closed = false;
  private overflow = false;
  constructor(private readonly options: Options) {}
  get active(): boolean {
    return !this.closed && (this.overflow || [...this.tasks.values()].some(taskActive));
  }
  get warning(): string | undefined {
    return this.overflow ? 'Claude 后台任务超过128条跟踪容量，未登记任务仍保守占用工作区；关闭实例后释放。' : undefined;
  }
  snapshot(): RuntimeTaskSnapshot[] {
    return structuredClone([...this.tasks.values()]);
  }
  ownsAgent(id: string): boolean {
    const task = this.tasks.get(id);
    return !!task && task.kind === 'local_agent' && taskActive(task) && !this.closed;
  }
  observe(message: unknown): void {
    const value = record(message);
    if (this.closed || value.type !== 'system' || value.session_id !== this.options.sessionId()) return;
    if (value.subtype === 'background_tasks_changed') this.replace(value.tasks);
    else this.update(value);
  }
  private replace(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    if (raw.length > 128) {
      this.capacity('Claude 后台任务超过128条跟踪容量，未登记任务不能单独停止；当前实例将保守保持活动。');
      return;
    }
    this.overflow = false;
    const live = new Set<string>();
    for (const value of raw) {
      const task = this.description(record(value));
      if (!task) continue;
      if (!this.reserve(task.id)) {
        this.capacity(task.id);
        continue;
      }
      this.updateLive(task);
      live.add(task.id);
    }
    this.expireMissing(live);
    this.options.changed();
  }
  private reserve(id: string) {
    if (!this.tasks.has(id)) this.makeRoom();
    return this.tasks.has(id) || this.tasks.size < 128;
  }
  private updateLive(task: RuntimeTaskSnapshot) {
    this.tasks.set(task.id, { ...this.tasks.get(task.id), ...task, status: 'running', canStop: true });
  }
  private expireMissing(live: Set<string>) {
    for (const task of this.tasks.values()) {
      if (live.has(task.id) || terminal(task) || !task.background) continue;
      task.status = 'unknown';
      task.canStop = false;
      this.options.released?.(task.id);
    }
  }
  private capacity(id: string) {
    this.overflow = true;
    this.options.capacity?.(id);
    this.options.changed();
  }
  private description(value: Record<string, unknown>): RuntimeTaskSnapshot | undefined {
    const id = text(value.task_id),
      sessionId = this.options.sessionId();
    if (!id || id.length > 200 || !sessionId) return;
    return {
      id,
      sessionId,
      name: text(value.description).slice(0, 500) || '原生任务',
      kind: text(value.task_type).slice(0, 100),
      status: 'running',
      background: true,
      ambient: value.ambient === true,
      canStop: true,
    };
  }
  private update(value: Record<string, unknown>): void {
    const id = text(value.task_id);
    const task = this.tasks.get(id) ?? this.started(value);
    if (!task) return;
    const status = nativeStatus(value);
    if (status) {
      task.status = status;
      task.canStop = false;
      this.waiting.get(id)?.resolve();
      this.waiting.delete(id);
    }
    if (value.subtype === 'task_progress' && typeof value.description === 'string')
      task.name = value.description.slice(0, 500);
    if (value.subtype === 'task_started' && !terminal(task)) task.kind = text(value.task_type) || task.kind;
    this.options.changed();
  }
  private started(value: Record<string, unknown>): RuntimeTaskSnapshot | undefined {
    if (value.subtype !== 'task_started') return;
    const task = this.description(value);
    if (!task) return;
    if (!this.reserve(task.id)) {
      this.capacity(task.id);
      return;
    }
    task.background = value.is_backgrounded === true;
    task.canStop = task.background;
    this.tasks.set(task.id, task);
    return task;
  }
  private makeRoom(): void {
    for (const [id, task] of this.tasks) {
      if (taskActive(task) || this.waiting.has(id)) continue;
      this.tasks.delete(id);
      this.options.released?.(id);
      if (this.tasks.size < 128) return;
    }
  }
  async stopTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (this.closed || !task?.canStop || this.waiting.has(id)) throw missing();
    let timer: NodeJS.Timeout | undefined;
    const finished = new Promise<void>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      timer = setTimeout(
        () => reject(new SessionError(503, 'task_stop_unconfirmed', '原生尚未确认任务停止，请刷新状态后核对。')),
        10_000,
      );
      timer.unref();
    });
    try {
      // RPC失败与确认超时均消费；返回成功必须等原生终态通知。
      await Promise.race([this.options.stop(id).then(() => finished), finished]);
    } finally {
      clearTimeout(timer);
      this.waiting.delete(id);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, task] of this.tasks) {
      if (taskActive(task)) task.status = 'unknown';
      task.canStop = false;
      this.options.released?.(id);
    }
    for (const wait of this.waiting.values()) wait.reject(missing());
    this.waiting.clear();
    this.options.changed();
  }
}
function nativeStatus(value: Record<string, unknown>): RuntimeTaskSnapshot['status'] | undefined {
  const status =
    value.subtype === 'task_notification'
      ? value.status
      : value.subtype === 'task_updated'
        ? record(value.patch).status
        : undefined;
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'stopped' || status === 'killed') return 'cancelled';
}
