import { taskActive, type RuntimeTaskSnapshot } from '@agentdeck/shared/conversation';
import { sameSessionDirectory } from '../../common/history/session-scope';
import { SessionError } from '../../errors';
import { record, text, type RecordValue } from '../run/types';

type Child = {
  task: RuntimeTaskSnapshot;
  parent: string;
  depth: number;
  verified: boolean;
  turnId?: string;
  completed: Set<string>;
  verificationAttempts: number;
};
type Options = {
  root(): string | undefined;
  cwd: string;
  read(id: string): Promise<RecordValue>;
  stop(id: string, turnId: string): Promise<void>;
  changed(): void;
  discovered?(id: string): void;
  released?(id: string): void;
  capacity?(message: string): void;
  retryDelay?(attempt: number): Promise<void>;
};
const unavailable = () => new SessionError(409, 'task_unavailable', '子代理任务已结束或尚未核实当前实例归属。');
export class CodexTasks {
  private readonly children = new Map<string, Child>();
  private readonly waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  private updates = Promise.resolve();
  private closed = false;
  private overflow = false;
  constructor(private readonly options: Options) {}
  get active(): boolean {
    return !this.closed && (this.overflow || [...this.children.values()].some((child) => taskActive(child.task)));
  }
  get warning(): string | undefined {
    return this.overflow ? 'Codex 子代理超过128条跟踪容量，未跟踪活动仍保守占用工作区；关闭实例后释放。' : undefined;
  }
  snapshot(): RuntimeTaskSnapshot[] {
    return structuredClone([...this.children.values()].map((child) => child.task));
  }
  owns(id: string, turnId?: string): boolean {
    const child = this.children.get(id);
    return !!child?.verified && !this.closed && (turnId === undefined || child.turnId === turnId);
  }
  settled(): Promise<void> {
    return this.updates;
  }
  notify(method: string, params: RecordValue): void {
    if (this.closed) return;
    const item = record(params.item),
      threadId = text(params.threadId);
    if (item.type === 'subAgentActivity' && ['item/started', 'item/completed'].includes(method))
      this.discover(threadId, item);
    if (['turn/started', 'turn/completed', 'thread/status/changed'].includes(method) && this.children.has(threadId))
      this.updates = this.updates.then(() => this.turn(method, threadId, params));
  }
  private discover(parentId: string, item: RecordValue): void {
    const root = this.options.root(),
      id = text(item.agentThreadId);
    if (!root || !id || id === root || this.children.has(id)) return;
    this.pruneTerminal();
    if (this.children.size >= 128) {
      this.overflow = true;
      this.options.capacity?.(
        'Codex 后台子任务已达 128 条跟踪上限，新任务暂不能单独显示或停止；当前实例将保守保持活动租约。',
      );
      this.options.changed();
      return;
    }
    const depth = this.childDepth(parentId, root);
    if (depth === undefined) return;
    const child: Child = {
      parent: parentId,
      depth,
      verified: false,
      completed: new Set(),
      verificationAttempts: 0,
      task: {
        id,
        sessionId: root,
        parentTaskId: parentId === root ? undefined : parentId,
        kind: 'subagent',
        name: '子代理',
        background: true,
        status: 'waiting',
        canStop: false,
      },
    };
    this.children.set(id, child);
    this.options.discovered?.(id);
    this.options.changed();
    this.updates = this.updates.then(() => this.verify(child));
  }
  private childDepth(parentId: string, root: string): number | undefined {
    if (parentId === root) return 1;
    const parent = this.children.get(parentId);
    if (parent && parent.depth < 10) return parent.depth + 1;
  }
  private async verify(child: Child): Promise<void> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        child.verificationAttempts++;
        const result = await this.verifyAttempt(child);
        if (result !== 'failed' || this.closed) return;
        if (attempt < 2) await (this.options.retryDelay?.(attempt + 1) ?? delay([100, 500][attempt]!));
      }
      if (!this.closed) child.task.status = 'waiting';
    } catch {
      if (!this.closed) child.task.status = 'waiting';
    } finally {
      this.options.changed();
    }
  }
  private async verifyAttempt(child: Child): Promise<'verified' | 'invalid' | 'failed'> {
    if (child.parent !== this.options.root() && !this.children.get(child.parent)?.verified) {
      if (!this.children.has(child.parent)) this.remove(child.task.id);
      return 'invalid';
    }
    try {
      const value = await this.options.read(child.task.id);
      const spawn = record(record(record(value.source).subAgent).thread_spawn);
      if (this.closed) return 'invalid';
      if (!(await this.validChild(child, value, spawn))) {
        this.remove(child.task.id);
        return 'invalid';
      }
      child.verified = true;
      child.task.name = text(spawn.agent_nickname).slice(0, 500) || '子代理';
      child.task.status = 'running';
      return 'verified';
    } catch {
      return 'failed';
    }
  }
  private async validChild(child: Child, value: RecordValue, spawn: RecordValue): Promise<boolean> {
    return (
      value.id === child.task.id &&
      value.parentThreadId === child.parent &&
      spawn.parent_thread_id === child.parent &&
      spawn.depth === child.depth &&
      (await sameSessionDirectory(text(value.cwd), this.options.cwd))
    );
  }
  private async turn(method: string, id: string, params: RecordValue): Promise<void> {
    const child = this.children.get(id);
    if (this.closed || !child) return;
    if (!child.verified) {
      await this.verify(child);
      if (!child.verified || this.closed) return;
    }
    const turn = record(params.turn),
      turnId = text(turn.id);
    if (method === 'turn/started') this.started(child, turnId);
    else if (method === 'turn/completed') this.completed(child, id, turnId, turn.status);
    this.options.changed();
  }
  private started(child: Child, turnId: string) {
    if (!turnId || child.completed.has(turnId)) return;
    // 上一轮终态已释放请求owner；已核验子线程的新轮次需要重新登记。
    this.options.discovered?.(child.task.id);
    child.turnId = turnId;
    child.task.status = 'running';
    child.task.canStop = true;
  }
  private completed(child: Child, id: string, turnId: string, status: unknown) {
    if (child.turnId !== turnId) return;
    child.completed.add(turnId);
    this.options.released?.(id);
    child.turnId = undefined;
    child.task.status = endedStatus(status);
    child.task.canStop = false;
    this.pruneTerminal();
    this.waiting.get(id)?.resolve();
    this.waiting.delete(id);
  }
  private remove(id: string) {
    if (this.children.delete(id)) this.options.released?.(id);
  }
  private pruneTerminal() {
    for (const [id, child] of this.children) {
      if (this.children.size < 128) break;
      if (taskActive(child.task) || this.waiting.has(id)) continue;
      this.remove(id);
    }
  }
  async stopTask(id: string): Promise<void> {
    const child = this.children.get(id),
      turnId = child?.turnId;
    if (this.closed || !child?.task.canStop || !turnId || this.waiting.has(id)) throw unavailable();
    let timer: NodeJS.Timeout | undefined;
    const ended = new Promise<void>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      timer = setTimeout(() => reject(unavailable()), 10_000);
      timer.unref();
    });
    try {
      await Promise.race([this.options.stop(id, turnId).then(() => ended), ended]);
    } finally {
      clearTimeout(timer);
      this.waiting.delete(id);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.children.values()) {
      if (taskActive(child.task)) child.task.status = 'unknown';
      child.task.canStop = false;
    }
    for (const wait of this.waiting.values()) wait.reject(unavailable());
    this.waiting.clear();
    this.options.changed();
  }
}
function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
function endedStatus(status: unknown): RuntimeTaskSnapshot['status'] {
  if (status === 'completed') return 'completed';
  return status === 'interrupted' ? 'cancelled' : 'failed';
}
