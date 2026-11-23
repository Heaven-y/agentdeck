// 长驻 Codex 会话：一个 app-server 进程承载同一原生线程的多轮对话，空闲后回收。
import type { AgentEvent } from '@agentdeck/shared/conversation';
import type { AgentTurnInput, NativeSteerInput, NativeInputResult, RuntimeControl } from '../../contracts';
import { CodexTasks } from '../tasks/tasks';
import { CodexBackgroundTerminals } from '../tasks/background-terminals';
import { CodexChildRequests } from '../interaction/child-requests';
import { codexCollaboration, codexReviewTarget, verifyCodexMode } from '../history/native-actions';
import { sameSessionDirectory } from '../../common/history/session-scope';
import { CodexClient } from './client';
import { validateCodexSkill } from '../capabilities';
import { threadParams } from './config';
import { nativePermissionRestore } from '../interaction/permission-mode';
import { CodexEventMapper, codexTurnFailure, turnEnd } from './mapper';
import { CodexPermissions } from '../interaction/permissions';
import { CodexInteractions } from '../interaction/interactions';
import { codexAttachments, markEmbedded } from '../../common/media/attachment-input';
import { codexMcpControl } from '../interaction/mcp-control';
import { randomUUID } from 'node:crypto';
import { checkedThread } from '../history/sessions';
import { emptyCodexUsage, updateCodexUsageBaseline, type CodexUsageBreakdown } from './observability';
import {
  cancelled,
  CodexError,
  record,
  safeError,
  text,
  type CodexRuntimeOptions,
  type RecordValue,
  type ServerRequest,
} from './types';

const INTERRUPT_FALLBACK_MS = 5_000;
const TURN_START_TIMEOUT_MS = 30_000;

export class CodexRuntime {
  private readonly mcpInstanceId = randomUUID();
  private releaseMcp?: () => void;
  private client?: CodexClient;
  private nativeConfig?: RecordValue;
  private thread?: string;
  private model?: string;
  private connecting?: Promise<CodexClient>;
  private closing?: Promise<void>;
  private broken = false;
  private completedTurnId?: string;
  /** 仅由完整轮次边界推进；恢复历史时不假定累计用量从零开始。 */
  usageBaseline?: CodexUsageBreakdown;
  current?: CodexTurn;
  interactions?: CodexInteractions;
  private interactionInput?: AgentTurnInput;
  tasks?: CodexTasks;
  private backgroundTerminals?: CodexBackgroundTerminals;
  private terminalTimer?: NodeJS.Timeout;
  private childRequests?: CodexChildRequests;
  private readonly taskListeners = new Set<() => void>();
  runtimeControl(): RuntimeControl | undefined {
    if (!this.thread || !this.tasks) return;
    const alive = this.isAlive.bind(this),
      tasks = this.tasks,
      backgroundTasks = () => this.backgroundTerminals?.snapshot() ?? [],
      backgroundActive = () => !!this.backgroundTerminals?.active,
      backgroundWarning = () => this.backgroundTerminals?.warning;
    return {
      instanceId: this.mcpInstanceId,
      sessionId: this.thread,
      get alive() {
        return alive();
      },
      tasks: () => [...tasks.snapshot(), ...backgroundTasks()],
      get taskActivity() {
        return tasks.active || backgroundActive();
      },
      get taskWarning() {
        return [tasks.warning, backgroundWarning()].filter(Boolean).join(' ') || undefined;
      },
      stopTask: (id) =>
        id.startsWith('codex-terminal:')
          ? (this.backgroundTerminals?.stopTask(id) ?? Promise.reject(new Error('后台终端已结束。')))
          : tasks.stopTask(id),
      close: () => this.close(),
      subscribe: (listener) => {
        this.taskListeners.add(listener);
        return () => this.taskListeners.delete(listener);
      },
      invalidateResources: async () => {
        if (this.current || tasks.active || backgroundActive()) throw new Error('原生实例仍有活动任务');
        await this.close();
      },
    };
  }

  constructor(private readonly options: CodexRuntimeOptions = {}) {}

  get alive(): boolean {
    return !this.broken && this.closing === undefined;
  }
  get hasBackground(): boolean {
    return !!this.tasks?.active || !!this.backgroundTerminals?.active;
  }
  private isAlive() {
    return this.alive;
  }

  get sessionId(): string | undefined {
    return this.thread || undefined;
  }

  get sessionModel(): string | undefined {
    return this.model;
  }

  finishUsage(turnId: string, snapshot?: CodexUsageBreakdown): void {
    if (turnId) this.completedTurnId = turnId;
    this.usageBaseline = snapshot;
    if (this.interactionInput)
      this.interactionInput = {
        ...this.interactionInput,
        text: '',
        attachments: undefined,
        attachmentsStored: undefined,
      };
  }

  private notification(method: string, params: RecordValue): void {
    this.tasks?.notify(method, params);
    this.childRequests?.notify(method, params);
    this.turnNotification(method, params);
    if (['item/started', 'item/completed', 'turn/completed'].includes(method) && params.threadId === this.thread)
      void this.backgroundTerminals?.refresh().then(
        () => this.scheduleTerminalRefresh(),
        () => this.scheduleTerminalRefresh(),
      );
  }
  private turnNotification(method: string, params: RecordValue): void {
    if (method === 'serverRequest/resolved') this.resolveRequest(params);
    const lateUsage =
      method === 'thread/tokenUsage/updated' &&
      params.threadId === this.thread &&
      !!this.completedTurnId &&
      params.turnId === this.completedTurnId &&
      !this.current?.matchesTurn(text(params.turnId));
    if (!lateUsage) {
      this.current?.notification(method, params);
      return;
    }
    // 结束后的补报可更新空闲基线；若下一轮已发送，其计数范围已经无法完整分离。
    this.usageBaseline = updateCodexUsageBaseline(this.usageBaseline, record(params.tokenUsage).total);
    this.current?.invalidateRunningUsage();
  }
  private resolveRequest(params: RecordValue): void {
    if (params.threadId === this.thread) this.interactions?.resolved(params.requestId);
  }

  /** 首次使用时启动进程并读取原生配置；后续轮次直接复用。 */
  async ensure(input: AgentTurnInput, signal: AbortSignal): Promise<{ client: CodexClient; threadId: string }> {
    this.interactionInput = input;
    const client = await this.connect(input, signal);
    if (input.sessionId) await this.assertNoUnmanagedGoal(client, input.sessionId);
    if (!this.thread) await this.openThread(client, input, signal);
    const control = this.runtimeControl();
    if (control) input.registerRuntime?.(control);
    return { client, threadId: this.thread! };
  }

  private async assertNoUnmanagedGoal(client: CodexClient, threadId: string): Promise<void> {
    let goal: RecordValue;
    try {
      goal = record((await client.request('thread/goal/get', { threadId })).goal);
    } catch (error) {
      if (error instanceof CodexError && error.nativeRejected && error.message.includes('不支持此实验性接口')) return;
      throw error;
    }
    if (goal.status === 'active')
      throw new CodexError('此 Codex 会话有正在运行的自主目标；请先在 Codex 中暂停目标，再从工作台续聊。', true);
  }

  private scheduleTerminalRefresh(): void {
    clearTimeout(this.terminalTimer);
    if (!this.backgroundTerminals?.active || !this.alive) return;
    this.terminalTimer = setTimeout(() => {
      void this.backgroundTerminals?.refresh().then(
        () => this.scheduleTerminalRefresh(),
        () => this.scheduleTerminalRefresh(),
      );
    }, 5_000);
    this.terminalTimer.unref?.();
  }

  close(): Promise<void> {
    this.broken = true;
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    clearTimeout(this.terminalTimer);
    this.releaseMcp?.();
    this.current?.cancel();
    this.childRequests?.close();
    await this.client?.close().catch(() => undefined);
    this.tasks?.close();
    this.backgroundTerminals?.close();
  }

  private connect(input: AgentTurnInput, signal: AbortSignal): Promise<CodexClient> {
    this.connecting ??= this.start(input, signal);
    return this.connecting;
  }

  private async start(input: AgentTurnInput, signal: AbortSignal): Promise<CodexClient> {
    const client = await CodexClient.start({
      ...this.options,
      cwd: input.workspace.dir,
      signal,
      experimentalApi: true,
    });
    this.client = client;
    this.tasks = new CodexTasks({
      root: () => this.thread,
      cwd: input.workspace.dir,
      read: async (id) => record((await client.request('thread/read', { threadId: id, includeTurns: false })).thread),
      stop: async (id, turnId) => {
        await client.request('turn/interrupt', { threadId: id, turnId });
      },
      changed: () => {
        for (const listener of this.taskListeners) listener();
      },
      discovered: (id) => this.childRequests?.remember(id, this.interactionInput ?? input),
      released: (id) => this.childRequests?.forget(id),
      capacity: (message) => (this.interactionInput ?? input).emit({ type: 'error', message }),
    });
    this.childRequests = new CodexChildRequests({
      client,
      tasks: this.tasks,
      runtimeId: this.mcpInstanceId,
      sessionId: () => this.thread,
    });
    this.interactions = new CodexInteractions(client, () => ({
      input: this.interactionInput ?? input,
      sessionId: this.sessionId ?? '',
      matchesTurn: (id) => !!this.current && !this.current.foreignRequest({ threadId: this.sessionId, turnId: id }),
    }));
    client.onRequest = (request: ServerRequest) => this.route(client, request);
    client.onNotification = (method: string, params: RecordValue) => this.notification(method, params);
    try {
      await client.initialize();
      await verifyCodexMode(client, input.collaborationMode);
      this.releaseMcp = this.options.mcpRegistry?.register({
        agent: 'codex',
        projectId: input.workspace.id,
        projectDir: input.projectDir ?? input.workspace.dir,
        cwd: input.workspace.dir,
        instanceId: this.mcpInstanceId,
        sessionId: () => this.sessionId,
        control: codexMcpControl(client, this.mcpInstanceId, () => this.sessionId),
      });
      this.nativeConfig = await client.request('config/read', {
        cwd: input.workspace.dir,
        includeLayers: false,
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      this.releaseMcp?.();
      this.connecting = undefined;
      throw error;
    }
    void client.closed.then(() => {
      this.releaseMcp?.();
      this.interactions?.close();
      this.broken = true;
      this.tasks?.close();
      this.childRequests?.close();
      this.current?.fail('Codex 进程已退出，请重新发送');
    });
    return client;
  }

  /** 未指定会话时新建原生线程，已指定时续接并复核目录归属。 */
  private async openThread(client: CodexClient, input: AgentTurnInput, signal: AbortSignal): Promise<void> {
    const id = input.sessionId;
    const params = threadParams(input, this.nativeConfig ?? {});
    if (id) await checkedThread(client, id, input.workspace.dir);
    Object.assign(params, await nativePermissionRestore(client, input));
    if (signal.aborted) throw cancelled();
    const response = await client.request(id ? 'thread/resume' : 'thread/start', {
      ...params,
      ...(id ? { threadId: id, excludeTurns: true } : {}),
    });
    const thread = record(response.thread);
    await this.verifyThread(thread, id, input.workspace.dir);
    this.thread = text(thread.id);
    this.model = text(response.model) || text(thread.model);
    this.usageBaseline = id ? undefined : emptyCodexUsage();
    this.backgroundTerminals = new CodexBackgroundTerminals({
      threadId: this.thread,
      request: (method, requestParams) => client.request(method, requestParams),
      changed: () => {
        for (const listener of this.taskListeners) listener();
      },
    });
    await this.backgroundTerminals.refresh().catch(() => undefined);
    this.scheduleTerminalRefresh();
  }

  /** 复核原生线程身份：必须带 ID、属于当前工作区，且与续接目标一致。 */
  private async verifyThread(thread: RecordValue, id: string | undefined, dir: string): Promise<void> {
    if (!text(thread.id) || !(await sameSessionDirectory(text(thread.cwd), dir))) {
      throw new CodexError('Codex 返回了不属于当前工作区的会话。');
    }
    if (id && thread.id !== id) throw new CodexError('Codex 返回的会话标识与续接目标不一致。');
  }

  private route(client: CodexClient, request: ServerRequest): void {
    if (this.childRequests?.request(request)) return;
    if (this.interactions?.request(request)) return;
    const turn = this.current;
    if (!turn || turn.foreignRequest(request.params)) client.rejectRequest(request.id);
    else turn.onRequest(request);
  }
}

export class CodexTurn {
  private readonly steers = new Map<
    string,
    { accepted: boolean; imageIds: string[]; onAccepted?: () => void; stored?: (ids: string[]) => Promise<void> }
  >();
  private accepted = false;
  canSteer(): boolean {
    return this.phase === 'running' && !this.stopped && this.input.invocation?.kind !== 'command' && !this.turnResult;
  }
  async steer(input: NativeSteerInput): Promise<NativeInputResult> {
    if (!this.canSteer() || !this.client) return { status: 'rejected', message: '本轮已结束或尚未受理，输入已保留。' };
    if (this.steers.has(input.clientMessageId))
      return { status: 'rejected', message: '此引导已经投递，不能再次发送。' };
    if (this.steers.size >= 32) return { status: 'rejected', message: '本轮追加输入已达到上限。' };
    const pending = steerReceipt(input);
    this.steers.set(input.clientMessageId, pending);
    try {
      const items = steerItems(input);
      if (!items.length) return { status: 'rejected', message: '引导内容不能为空。' };
      const response = await this.client.request('turn/steer', {
        threadId: this.runtime.sessionId,
        expectedTurnId: this.turnId,
        clientUserMessageId: input.clientMessageId,
        input: items,
      });
      if (response.turnId !== this.turnId)
        return { status: 'unknown', message: '这条消息可能已发送，请先重新读取会话。' };
      this.acknowledge(input.clientMessageId);
      return { status: 'accepted' };
    } catch (error) {
      if (pending.accepted) return { status: 'accepted' };
      return steerFailure(error);
    }
  }
  private acknowledge(id: string | undefined): void {
    if (id && id === this.input.clientMessageId && !this.accepted) {
      this.accepted = true;
      this.input.onInputAccepted?.();
    }
    const pending = id ? this.steers.get(id) : undefined;
    if (pending && !pending.accepted) {
      pending.accepted = true;
      pending.onAccepted?.();
    }
  }
  private readonly mapper: CodexEventMapper;
  private readonly manualCompaction: boolean;
  private readonly preparation = new AbortController();
  private permissions?: CodexPermissions;
  private client?: CodexClient;
  private phase: 'preparing' | 'starting' | 'running' | 'done' = 'preparing';
  private stopped = false;
  private turnId = '';
  private interruptSent = false;
  private interruptTimer?: NodeJS.Timeout;
  private readonly earlyNotifications: Array<{ method: string; params: RecordValue }> = [];
  readonly done: Promise<void>;
  private complete!: () => void;
  private readonly started: Promise<void>;
  private start!: () => void;
  private readonly onAbort = () => void this.interrupt();

  constructor(
    private readonly runtime: CodexRuntime,
    private readonly input: AgentTurnInput,
    signal: AbortSignal,
  ) {
    this.manualCompaction = input.invocation?.kind === 'command' && input.invocation.name === 'compact';
    this.mapper = new CodexEventMapper({ manualCompaction: this.manualCompaction });
    this.done = new Promise<void>((resolve) => {
      this.complete = resolve;
    });
    this.started = new Promise<void>((resolve) => {
      this.start = resolve;
    });
    signal.addEventListener('abort', this.onAbort, { once: true });
    if (signal.aborted) this.stopped = true;
  }

  get foreignThreadId(): string {
    return this.runtime.sessionId ?? '';
  }

  matchesTurn(id: string): boolean {
    return this.phase !== 'done' && this.turnId === id;
  }

  invalidateRunningUsage(): void {
    if (this.phase !== 'preparing') this.mapper.invalidateUsage();
  }

  async run(): Promise<void> {
    let end: Extract<AgentEvent, { type: 'turn_end' }> = { type: 'turn_end', isError: false };
    try {
      this.ensureActive();
      this.validateInput();
      const { client, threadId } = await this.runtime.ensure(this.input, this.preparation.signal);
      this.client = client;
      this.mapper.setModel(this.runtime.sessionModel ?? '');
      this.mapper.setSessionId(threadId);
      this.permissions = new CodexPermissions(client, this.input, this.mapper);
      this.input.emit({
        type: 'session',
        sessionId: threadId,
        model: this.runtime.sessionModel ?? '',
        cwd: this.input.workspace.dir,
        agent: 'codex',
      });
      this.ensureActive();
      end = await this.startTurn(client, threadId);
    } catch (error) {
      if (!this.stopped) {
        end = { type: 'turn_end', isError: true };
        this.input.emit({ type: 'error', message: safeError(error) });
      }
    } finally {
      this.finish(end);
    }
  }
  private finish(end: Extract<AgentEvent, { type: 'turn_end' }>): void {
    this.finishUsage();
    this.runtime.interactions?.cancelTurn(this.turnId);
    this.phase = 'done';
    clearTimeout(this.interruptTimer);
    this.permissions?.cancel();
    for (const event of this.mapper.finishCompaction(this.stopped ? 'interrupted' : 'failed')) this.input.emit(event);
    this.input.emit({ ...end, isError: end.isError || this.stopped });
    if (this.runtime.current === this) this.runtime.current = undefined;
    this.complete();
  }

  /** 其他线程或轮次的审批请求不属于本会话，直接拒绝。 */
  foreignRequest(params: RecordValue): boolean {
    return (
      (!!this.runtime.sessionId && params.threadId !== this.runtime.sessionId) ||
      (!!this.turnId && params.turnId !== this.turnId)
    );
  }

  private finishUsage(): void {
    const snapshot =
      !this.stopped && this.turnResult?.status === 'completed' ? this.mapper.cumulativeUsage() : undefined;
    this.runtime.finishUsage(this.turnId, snapshot);
  }

  onRequest(request: ServerRequest): void {
    this.permissions?.request(request);
  }

  cancel(): void {
    this.stopped = true;
    this.permissions?.cancel();
    this.preparation.abort();
  }

  fail(message: string): void {
    if (this.phase === 'done') return;
    this.input.emit({ type: 'error', message });
  }

  notification(method: string, params: RecordValue): void {
    const threadId = this.runtime.sessionId;
    if (!threadId || params.threadId !== threadId || this.phase === 'done') return;
    if (this.threadNotification(method, params) || this.phase === 'preparing') return;
    if (method === 'turn/started') {
      this.identifyTurn(text(record(params.turn).id));
      return;
    }
    if (!this.turnId) {
      if (this.earlyNotifications.length >= 128) {
        this.client?.terminate(new CodexError('Codex 轮次开始前的通知过多。'));
      } else {
        this.earlyNotifications.push({ method, params });
      }
      return;
    }
    this.currentNotification(method, params);
  }

  interrupt(): Promise<void> {
    if (this.phase === 'done' || this.stopped) return Promise.resolve();
    this.stopped = true;
    this.permissions?.cancel();
    if (this.phase === 'preparing') {
      this.preparation.abort();
      return Promise.resolve();
    }
    this.interruptTimer = setTimeout(() => this.client?.terminate(), INTERRUPT_FALLBACK_MS);
    this.sendInterrupt();
    return Promise.resolve();
  }

  private ensureActive(): void {
    if (this.stopped) throw cancelled();
  }

  private validateInput(): void {
    if (this.input.invocation?.kind !== 'command') return;
    if (this.input.invocation.name === 'review') {
      codexReviewTarget(this.input.text);
      return;
    }
    if (this.input.invocation.name === 'context')
      throw new CodexError('当前 Codex app-server 没有独立上下文查询接口，请在本机 CLI 中查看。');
    if (!this.input.sessionId) throw new CodexError('Codex 压缩需要先选择已有会话。');
    if (this.input.text.trim()) throw new CodexError('Codex 手动压缩不支持附加参数。');
  }

  private async startTurn(client: CodexClient, threadId: string): Promise<Extract<AgentEvent, { type: 'turn_end' }>> {
    if (this.input.invocation?.kind === 'skill')
      await validateCodexSkill(client, this.input.workspace.dir, this.input.invocation);
    this.ensureActive();
    this.mapper.beginUsage(this.runtime.usageBaseline);
    this.phase = 'starting';
    await this.sendTurn(client, threadId);
    await this.waitForStart(client);
    const turn = await Promise.race([
      this.turnCompleted,
      client.closed.then(() => {
        throw new CodexError('Codex 进程在轮次完成前退出。');
      }),
    ]);
    for (const event of this.mapper.finishItems(turn)) this.input.emit(event);
    for (const event of this.mapper.finishCompaction(text(turn.status))) this.input.emit(event);
    if (this.manualCompaction && turn.status === 'completed' && !this.mapper.compactionConfirmed())
      throw new CodexError('Codex 未确认本次压缩完成，请重新读取会话状态。');
    const failure = codexTurnFailure(turn);
    if (failure) this.input.emit(failure);
    if (turn.status === 'completed') {
      await markEmbedded(this.input, ['image']);
      await this.storeSteerImages();
    }
    return turnEnd(turn, this.mapper.turnUsage());
  }
  private async storeSteerImages(): Promise<void> {
    for (const pending of this.steers.values())
      if (pending.accepted && pending.imageIds.length) await pending.stored?.(pending.imageIds).catch(() => undefined);
  }

  private turnResult?: RecordValue;
  private turnResolve?: (turn: RecordValue) => void;
  private readonly turnCompleted = new Promise<RecordValue>((resolve) => {
    this.turnResolve = resolve;
  });

  private async sendTurn(client: CodexClient, threadId: string): Promise<void> {
    if (this.input.invocation?.kind === 'command' && this.input.invocation.name === 'review') {
      const result = await client.request('review/start', {
        threadId,
        target: codexReviewTarget(this.input.text),
        delivery: 'inline',
      });
      this.acceptStarted(result);
      return;
    }
    if (this.manualCompaction) {
      for (const event of this.mapper.startManualCompaction()) this.input.emit(event);
      this.ensureActive();
      await client.request('thread/compact/start', { threadId });
      return;
    }
    const response = await client.request('turn/start', {
      threadId,
      input: this.inputItems(),
      ...(this.input.clientMessageId ? { clientUserMessageId: this.input.clientMessageId } : {}),
      ...(this.input.model ? { model: this.input.model } : {}),
      ...(this.input.reasoningEffort ? { effort: this.input.reasoningEffort } : {}),
      ...codexCollaboration(this.input.collaborationMode, {
        model: this.runtime.sessionModel,
        effort: this.input.reasoningEffort,
      }),
    });
    this.acceptStarted(response);
  }
  private acceptStarted(response: RecordValue): void {
    const id = text(record(response.turn).id);
    if (!id || (this.turnId && this.turnId !== id)) throw new CodexError('Codex 未返回有效的轮次标识。');
    this.identifyTurn(id);
    this.acknowledge(this.input.clientMessageId);
  }

  private inputItems(): RecordValue[] {
    const items: RecordValue[] = [];
    if (this.input.text.trim()) items.push({ type: 'text', text: this.input.text, text_elements: [] });
    const invocation = this.input.invocation;
    if (invocation?.kind === 'skill') items.push({ type: 'skill', name: invocation.name, path: invocation.path });
    items.push(...codexAttachments(this.input.attachments));
    if (!items.length) throw new CodexError('请输入消息或选择技能。');
    return items;
  }

  private async waitForStart(client: CodexClient): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.started,
        client.closed.then(() => {
          throw new CodexError('Codex 在轮次开始前退出。');
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CodexError('Codex 未发送轮次开始通知。')), TURN_START_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private identifyTurn(id: string): void {
    if (!id || this.phase === 'done' || (this.turnId && this.turnId !== id)) return;
    this.turnId = id;
    this.phase = 'running';
    this.start();
    if (this.stopped) this.sendInterrupt();
    for (const event of this.earlyNotifications.splice(0)) this.currentNotification(event.method, event.params);
  }

  private threadNotification(method: string, params: RecordValue): boolean {
    if (method === 'serverRequest/resolved') {
      this.permissions?.resolved(params.requestId);
      return true;
    }
    return false;
  }

  private currentNotification(method: string, params: RecordValue): void {
    const eventTurnId = text(params.turnId) || text(record(params.turn).id);
    if (eventTurnId !== this.turnId) return;
    this.acknowledgeItem(method, params);
    if (method === 'turn/completed') {
      const turn = record(params.turn);
      if (turn.id === this.turnId && !this.turnResult) {
        this.turnResult = turn;
        this.turnResolve?.(turn);
      }
      return;
    }
    for (const event of this.mapper.map(method, params)) this.input.emit(event);
  }
  private acknowledgeItem(method: string, params: RecordValue): void {
    if (!['item/started', 'item/completed'].includes(method)) return;
    const item = record(params.item);
    if (item.type === 'userMessage') this.acknowledge(text(item.clientId));
  }

  private sendInterrupt(): void {
    if (!this.turnId || !this.client || this.interruptSent) return;
    this.interruptSent = true;
    void this.client
      .request('turn/interrupt', { threadId: this.runtime.sessionId ?? '', turnId: this.turnId })
      .catch(() => this.client?.terminate());
  }
}

function steerReceipt(input: NativeSteerInput) {
  return {
    accepted: false,
    imageIds: input.attachments?.filter((file) => file.kind === 'image').map((file) => file.id) ?? [],
    onAccepted: input.onAccepted,
    stored: input.attachmentsStored,
  };
}
function steerItems(input: NativeSteerInput): RecordValue[] {
  return [
    ...(input.text.trim() ? [{ type: 'text', text: input.text, text_elements: [] }] : []),
    ...codexAttachments(input.attachments),
  ];
}
function steerFailure(error: unknown): NativeInputResult {
  return error instanceof CodexError && error.nativeRejected
    ? { status: 'rejected', message: 'Codex 拒绝了本次引导，输入已保留。' }
    : { status: 'unknown', message: '这条消息可能已发送，请先重新读取会话。' };
}
