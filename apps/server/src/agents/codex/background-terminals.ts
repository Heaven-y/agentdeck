import type { RuntimeTaskSnapshot } from '@agentdeck/shared/conversation';
import type { RecordValue } from './types';
import { randomUUID } from 'node:crypto';
import { record, text } from './types';

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const MAX_TERMINALS = PAGE_SIZE * MAX_PAGES;
const MAX_ID_LENGTH = 200;
const unavailable = () => new Error('Codex 后台终端已结束或不属于当前运行实例。');

type NativeTerminal = { itemId: string; processId: string };
type Options = {
  threadId: string;
  request(method: string, params: RecordValue): Promise<RecordValue>;
  changed?(): void;
};

function parseTerminal(value: unknown): NativeTerminal {
  const item = record(value);
  const processId = text(item.processId),
    itemId = text(item.itemId);
  if (!processId || !itemId || processId.length > MAX_ID_LENGTH || itemId.length > MAX_ID_LENGTH) throw unavailable();
  return { processId, itemId };
}

function addPage(response: RecordValue, found: Map<string, NativeTerminal>): void {
  if (!Array.isArray(response.data) || response.data.length > PAGE_SIZE) throw unavailable();
  for (const value of response.data) {
    const terminal = parseTerminal(value);
    if (found.has(terminal.processId) || found.size >= MAX_TERMINALS) throw unavailable();
    found.set(terminal.processId, terminal);
  }
}

function pageCursor(response: RecordValue): string | undefined {
  const cursor = response.nextCursor;
  if (cursor === undefined || cursor === null || cursor === '') return;
  if (typeof cursor !== 'string' || cursor.length > MAX_ID_LENGTH) throw unavailable();
  return cursor;
}

/** 只控制创建此对象的 app-server 实例内、固定原生线程的后台终端。 */
export class CodexBackgroundTerminals {
  private readonly terminals = new Map<string, { processId: string; task: RuntimeTaskSnapshot }>();
  private readonly stopping = new Set<string>();
  private readonly readFailureTaskId = `codex-terminal-read-error:${randomUUID()}`;
  private closed = false;
  private readFailed = false;
  private supported = true;
  private refreshing?: Promise<RuntimeTaskSnapshot[]>;

  constructor(private readonly options: Options) {
    if (!options.threadId || options.threadId.length > MAX_ID_LENGTH) throw unavailable();
  }

  get active(): boolean {
    return !this.closed && this.supported && (this.readFailed || this.terminals.size > 0);
  }

  get available(): boolean {
    return this.supported && !this.closed;
  }

  get warning(): string | undefined {
    return this.readFailed ? 'Codex 后台终端状态暂不可读，保留活动租约；请重新读取或停止原生任务。' : undefined;
  }

  snapshot(): RuntimeTaskSnapshot[] {
    const tasks = [...this.terminals.values()].map(({ task }) => task);
    if (this.readFailed && tasks.length === 0)
      tasks.push({
        id: this.readFailureTaskId,
        sessionId: this.options.threadId,
        name: '后台终端状态暂不可读',
        kind: 'shell',
        background: true,
        status: 'waiting',
        canStop: false,
      });
    return structuredClone(tasks);
  }

  async refresh(): Promise<RuntimeTaskSnapshot[]> {
    if (this.closed || !this.supported) throw unavailable();
    this.refreshing ??= this.readAndReplace().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async readAndReplace(): Promise<RuntimeTaskSnapshot[]> {
    try {
      const found = await this.readAll();
      this.replace(found);
      this.readFailed = false;
      this.options.changed?.();
      return this.snapshot();
    } catch (error) {
      if (error instanceof Error && 'nativeRejected' in error && error.nativeRejected === true) {
        this.supported = false;
        this.readFailed = false;
        this.terminals.clear();
        this.options.changed?.();
        return [];
      }
      this.readFailed = true;
      this.options.changed?.();
      throw unavailable();
    }
  }

  private async readAll(): Promise<Map<string, NativeTerminal>> {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const found = new Map<string, NativeTerminal>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = record(
        await this.options.request('thread/backgroundTerminals/list', {
          threadId: this.options.threadId,
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }),
      );
      addPage(response, found);
      const next = pageCursor(response);
      if (next === undefined) return found;
      if (cursors.has(next) || page === MAX_PAGES - 1) throw unavailable();
      cursors.add(next);
      cursor = next;
    }
    throw unavailable();
  }

  async stopTask(taskId: string): Promise<void> {
    const entry = this.find(taskId);
    if (!entry || this.closed || !this.supported || this.stopping.has(taskId)) throw unavailable();
    this.stopping.add(taskId);
    try {
      const result = record(
        await this.options.request('thread/backgroundTerminals/terminate', {
          threadId: this.options.threadId,
          processId: entry.processId,
        }),
      );
      if (result.terminated !== true) throw unavailable();
      await this.refresh();
      if (this.terminals.has(entry.processId)) throw unavailable();
    } finally {
      this.stopping.delete(taskId);
    }
  }

  async clean(): Promise<void> {
    if (this.closed || !this.supported || this.stopping.size > 0) throw unavailable();
    const result = record(
      await this.options.request('thread/backgroundTerminals/clean', { threadId: this.options.threadId }),
    );
    if (Object.keys(result).length !== 0) throw unavailable();
    await this.refresh();
    if (this.terminals.size !== 0) throw unavailable();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.supported = false;
    this.readFailed = false;
    for (const { task } of this.terminals.values()) task.canStop = false;
    this.options.changed?.();
  }

  private find(taskId: string) {
    for (const entry of this.terminals.values()) if (entry.task.id === taskId) return entry;
  }

  private replace(found: Map<string, NativeTerminal>): void {
    const next = new Map<string, { processId: string; task: RuntimeTaskSnapshot }>();
    for (const terminal of found.values()) {
      const id = `codex-terminal:${terminal.processId}`;
      next.set(terminal.processId, {
        processId: terminal.processId,
        task: {
          id,
          sessionId: this.options.threadId,
          name: 'Codex 后台终端',
          kind: 'shell',
          background: true,
          status: 'running',
          canStop: true,
        },
      });
    }
    this.terminals.clear();
    for (const [id, entry] of next) this.terminals.set(id, entry);
  }
}
