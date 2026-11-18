import { claudePermissionOptions } from '../interaction/permissions';
// 长驻 Claude 运行时：一个原生进程承载同一会话的多轮对话，空闲超时后回收。
import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { askClaudeQuestion } from '../interaction/interactions';
import { ClaudeElicitationOwner } from '../interaction/elicitation-owner';
import { claudeInput, markEmbedded } from '../../common/media/attachment-input';
import { claudeMcpControl } from '../interaction/mcp-control';
import type { McpRuntimeRegistry } from '../../../native-management/mcp/mcp-runtime';
import type { AgentEvent } from '@agentdeck/shared/conversation';
import { taskActive } from '@agentdeck/shared/conversation';
import type { AgentTurnInput, TurnHandle, RuntimeControl } from '../../contracts';
import { ClaudeTasks } from './tasks';
import { claudeInvocationText } from '../capabilities';
import { claudeEffort } from '../effort';
import { ClaudeCompactionTracker } from './compaction';
import { ClaudeEventMapper } from './mapper';
import {
  claudeControl,
  createClaudeStream,
  nativeClaudeQuery,
  readClaudeContext,
  type ClaudeQuery,
  type QueryFn,
} from './query';

export const PERMISSION_TIMEOUT_MS = 300_000;
const ABORT_FALLBACK_MS = 5_000;
/** 手动压缩是控制操作，原生保留/重放的对话不能作为本轮新增内容。 */
const COMPACTION_EVENTS = new Set<AgentEvent['type']>(['session', 'context', 'compaction', 'turn_end', 'error']);
type TurnEnd = Extract<AgentEvent, { type: 'turn_end' }>;

export type ClaudeTurnInput = AgentTurnInput & {
  queryFn?: QueryFn;
  env?: NodeJS.ProcessEnv;
  mcpRegistry?: McpRuntimeRegistry;
};

const commandIs = (input: AgentTurnInput, name: 'context' | 'compact') =>
  input.invocation?.kind === 'command' && input.invocation.name === name;
const isResult = (message: unknown): boolean =>
  !!message &&
  typeof message === 'object' &&
  'type' in message &&
  message.type === 'result' &&
  !('parent_tool_use_id' in message && message.parent_tool_use_id) &&
  !('parent_agent_id' in message && message.parent_agent_id);

/** 单轮状态：事件过滤、压缩跟踪与结束判定都属于这一轮，不属于进程。 */
class ClaudeTurn {
  readonly done: Promise<void>;
  readonly abort = new AbortController();
  private settle!: () => void;
  private ended = false;
  private stopped = false;
  private readonly manual: boolean;
  private readonly compaction: ClaudeCompactionTracker;
  private fallback?: NodeJS.Timeout;
  private sentAt?: number;
  private accepted = false;
  acknowledge(message: unknown): void {
    if (this.accepted || !this.input.clientMessageId || !message || typeof message !== 'object') return;
    const ids = inputAcknowledgements(message as Record<string, unknown>);
    if (!ids.includes(this.input.clientMessageId)) return;
    this.accepted = true;
    this.input.onInputAccepted?.();
  }

  markSent(): void {
    this.sentAt = performance.now();
  }

  elapsedMs(): number | undefined {
    return this.sentAt === undefined ? undefined : Math.max(0, performance.now() - this.sentAt);
  }

  constructor(readonly input: AgentTurnInput) {
    this.manual = commandIs(input, 'compact');
    this.compaction = new ClaudeCompactionTracker(this.manual);
    this.done = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }

  get active(): boolean {
    return !this.ended;
  }

  deliver(event: AgentEvent): void {
    if (this.ended) return;
    if (this.manual && !COMPACTION_EVENTS.has(event.type)) return;
    if (event.type === 'compaction') {
      const state = this.compaction.observe(event.state, this.stopped);
      if (state) this.input.emit({ type: 'compaction', state });
      return;
    }
    this.input.emit(event);
  }

  /** 原生 result 已到达：先收尾压缩状态，再输出本轮结束。 */
  complete(event: TurnEnd): void {
    if (this.ended) return;
    this.finishCompaction();
    this.input.emit({ ...event, isError: event.isError || this.compaction.manualFailed || this.stopped });
    this.end();
  }

  /** 中断或进程退出：已收到的事件保留，本轮以错误结束。 */
  fail(message?: string): void {
    if (this.ended) return;
    if (message) this.input.emit({ type: 'error', message });
    this.finishCompaction();
    this.input.emit({ type: 'turn_end', isError: true });
    this.end();
  }

  markStopped(): void {
    this.stopped = true;
  }

  /** 中断已生效时不再投递新的用户消息。 */
  get cancelled(): boolean {
    return this.stopped;
  }

  private finishCompaction(): void {
    const state = this.compaction.finish(this.stopped);
    if (state) this.input.emit({ type: 'compaction', state });
  }

  private end(): void {
    this.ended = true;
    clearTimeout(this.fallback);
    this.settle();
  }
}

export class ClaudeRuntime {
  private readonly instanceId = randomUUID();
  private readonly lifetime = new AbortController();
  private interactionInput: AgentTurnInput;
  private readonly elicitations: ClaudeElicitationOwner;
  private readonly stream = createClaudeStream();
  private readonly mapper = new ClaudeEventMapper();
  private readonly query?: ClaudeQuery;
  private releaseMcp?: () => void;
  private readonly consumer: Promise<void>;
  private current?: ClaudeTurn;
  private closing?: Promise<void>;
  private broken = false;
  /** 原生进程创建失败的原因；构造不抛错，改在轮次里按错误收尾。 */
  private launchError?: Error;
  sessionId?: string;
  private readonly taskListeners = new Set<() => void>();
  private readonly taskOwners = new Map<string, AgentTurnInput>();
  readonly tasks = new ClaudeTasks({
    sessionId: () => this.sessionId,
    stop: async (id) => {
      if (!this.query?.stopTask) throw new Error('当前SDK不支持停止任务');
      await this.query.stopTask(id);
    },
    changed: () => {
      const live = new Set(
        this.tasks
          .snapshot()
          .filter((task) => task.kind === 'local_agent' && taskActive(task))
          .map((task) => task.id),
      );
      for (const id of this.taskOwners.keys()) if (!live.has(id)) this.taskOwners.delete(id);
      for (const id of live)
        if (!this.taskOwners.has(id))
          this.taskOwners.set(id, {
            ...this.interactionInput,
            text: '',
            attachments: undefined,
            attachmentsStored: undefined,
          });
      for (const listener of this.taskListeners) listener();
    },
    released: (id) => this.taskOwners.delete(id),
    capacity: () =>
      this.interactionInput.emit({
        type: 'error',
        message: 'Claude 后台任务已达 128 条跟踪上限，新任务未登记，请核对原生任务状态。',
      }),
  });
  runtimeControl(): RuntimeControl | undefined {
    if (!this.sessionId) return;
    const alive = () => this.alive,
      tasks = this.tasks;
    return {
      instanceId: this.instanceId,
      sessionId: this.sessionId,
      get alive() {
        return alive();
      },
      tasks: () => this.tasks.snapshot(),
      get taskActivity() {
        return tasks.active;
      },
      get taskWarning() {
        return tasks.warning;
      },
      stopTask: (id) => this.tasks.stopTask(id),
      close: () => this.close(),
      subscribe: (listener) => {
        this.taskListeners.add(listener);
        return () => this.taskListeners.delete(listener);
      },
      invalidateResources: async () => {
        if (this.current?.active || this.tasks.active) throw new Error('原生实例仍有活动任务');
        await this.close();
      },
    };
  }
  private registerTasks(): void {
    const control = this.runtimeControl();
    if (control) this.interactionInput.registerRuntime?.(control);
  }

  constructor(input: ClaudeTurnInput) {
    this.interactionInput = input;
    this.registerTasks();
    this.elicitations = new ClaudeElicitationOwner(this.instanceId, () => ({
      input: this.interactionInput,
      sessionId: this.sessionId,
    }));
    const { workspace } = input;
    const effort = claudeEffort(input.reasoningEffort);
    const options = {
      cwd: workspace.dir,
      ...claudePermissionOptions(input.permission),
      ...(input.env ? { env: input.env } : {}),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      canUseTool: (
        toolName: string,
        toolInput: Record<string, unknown>,
        opts: { signal: AbortSignal; agentID?: string },
      ) => this.permission(toolName, toolInput, opts),
      onElicitation: (
        request: Parameters<NonNullable<Options['onElicitation']>>[0],
        context: Parameters<NonNullable<Options['onElicitation']>>[1],
      ) =>
        this.elicitations.request(request, {
          requestId: context.requestId,
          signal: AbortSignal.any([context.signal, this.lifetime.signal]),
        }),
      supportedDialogKinds: [],
      includePartialMessages: true,
      enableFileCheckpointing: true,
      ...(input.sessionId ? { resume: input.sessionId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(effort ? { effort } : {}),
    } as unknown as Options;
    this.sessionId = input.sessionId;
    try {
      this.query = (input.queryFn ?? nativeClaudeQuery)({ prompt: this.stream.prompt, options });
      this.releaseMcp = input.mcpRegistry?.register({
        agent: 'claude',
        projectId: input.workspace.id,
        projectDir: input.projectDir ?? input.workspace.dir,
        cwd: input.workspace.dir,
        instanceId: this.instanceId,
        sessionId: () => this.sessionId,
        control: claudeMcpControl(this.query, this.instanceId),
      });
    } catch (error) {
      // 原生进程创建失败不能让构造方抛错，改由首轮产出错误事件收尾。
      this.broken = true;
      this.launchError = error instanceof Error ? error : new Error('Claude 原生进程启动失败');
      this.consumer = Promise.resolve();
      return;
    }
    this.consumer = this.consume();
  }

  get alive(): boolean {
    return !this.broken && this.closing === undefined;
  }

  run(input: AgentTurnInput): TurnHandle {
    if (this.current?.active) throw new Error('Claude 运行时正在处理另一轮对话');
    this.interactionInput = input;
    this.registerTasks();
    const turn = new ClaudeTurn(input);
    this.mapper.beginTurn();
    this.current = turn;
    // 原生进程没起来时不再尝试投递，直接以启动错误收尾本轮。
    if (this.launchError) turn.fail(this.launchError.message);
    else void this.start(turn);
    return {
      interrupt: () => this.interrupt(turn),
      done: turn.done.then(() => {
        if (this.current === turn) this.current = undefined;
        if (this.interactionInput === input)
          this.interactionInput = { ...input, text: '', attachments: undefined, attachmentsStored: undefined };
      }),
    };
  }

  close(): Promise<void> {
    this.broken = true;
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.releaseMcp?.();
    this.lifetime.abort();
    this.elicitations.close();
    this.stream.close();
    try {
      this.query?.close();
    } catch {
      // 进程已退出时关闭是幂等的。
    }
    this.current?.fail();
    this.tasks.close();
    await this.consumer.catch(() => undefined);
  }

  /** 连续消费原生消息：跨轮保持同一迭代器，逐条投递给当前轮次。 */
  private async consume(): Promise<void> {
    try {
      for await (const message of this.query!) await this.dispatch(message);
      this.broken = true;
      this.current?.fail('Claude 原生进程已退出，请重新发送');
    } catch (error) {
      this.broken = true;
      if (!this.closing) this.current?.fail(error instanceof Error ? error.message : 'Claude 本轮运行失败');
    } finally {
      this.releaseMcp?.();
      this.lifetime.abort();
      this.elicitations.close();
      this.tasks.close();
    }
  }

  /** 单条原生消息的分发：轮次结束消息单独收尾，其余按事件映射后投递。 */
  private async dispatch(message: unknown): Promise<void> {
    const turn = this.current?.active ? this.current : undefined;
    turn?.acknowledge(message);
    this.tasks.observe(message);
    if (this.elicitations.complete(message)) return;
    if (turn && isResult(message)) {
      await this.finishTurn(turn, message);
      return;
    }
    for (const event of this.mapper.map(message)) {
      if (event.type === 'session') {
        this.sessionId = event.sessionId;
        this.registerTasks();
      }
      turn?.deliver(event);
    }
  }

  private async finishTurn(turn: ClaudeTurn, message: unknown): Promise<void> {
    const elapsed = turn.elapsedMs();
    turn.deliver({ type: 'context', usage: await readClaudeContext(this.query!) });
    let ended = false;
    for (const event of this.mapper.map(message)) {
      if (event.type === 'turn_end') {
        ended = true;
        if (!event.isError) await markEmbedded(turn.input, ['image', 'text', 'pdf']);
        turn.complete(elapsed === undefined ? event : { ...event, durationMs: elapsed, timingSource: 'observed' });
      } else {
        turn.deliver(event);
      }
    }
    if (!ended) turn.complete({ type: 'turn_end', isError: false });
  }

  private async start(turn: ClaudeTurn): Promise<void> {
    try {
      if (turn.input.invocation?.kind === 'command' && !this.sessionId) throw new Error('此 Claude 命令需要已有会话');
      if (commandIs(turn.input, 'context')) {
        const usage = await readClaudeContext(this.query!, turn.abort.signal);
        turn.deliver({ type: 'context', usage });
        turn.complete({ type: 'turn_end', isError: usage === null });
        return;
      }
      const text = await claudeInvocationText(this.query!, turn.input.invocation, turn.input.text, turn.abort.signal);
      // 中断已经生效时不再投递正文，避免取消后仍向原生进程发送用户消息。
      if (!turn.active || turn.cancelled) return;
      turn.markSent();
      this.stream.send(claudeInput(text, turn.input.attachments), turn.input.clientMessageId);
    } catch (error) {
      if (turn.active) turn.fail(error instanceof Error ? error.message : 'Claude 本轮运行失败');
    }
  }

  private async interrupt(turn: ClaudeTurn): Promise<void> {
    if (!turn.active) return;
    // SDK 的迟到 result 没有回合 ID；中断后不可将此流复用于下一轮。
    this.broken = true;
    turn.markStopped();
    turn.abort.abort();
    try {
      await claudeControl(this.query!.interrupt(), undefined, ABORT_FALLBACK_MS);
    } catch {
      // 原生拒绝中断时关闭运行时，避免残留无法取消的轮次。
      await this.close();
      return;
    }
    // 原生已确认中断：本轮立即收尾，否则长驻运行时会在没有后续事件时一直挂着。
    if (turn.active) turn.fail('本轮已中断');
  }

  /** canUseTool 由运行时创建一次，按调用时的活动轮次解析；本轮已结束时不再弹审批。 */
  private async permission(
    toolName: string,
    toolInput: Record<string, unknown>,
    opts: { signal: AbortSignal; agentID?: string },
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    if (opts.agentID) return this.childPermission(toolName, toolInput, opts.agentID, opts.signal);
    const turn = this.current;
    if (!turn?.active) return { behavior: 'deny', message: '本轮已结束' };
    if (toolName === 'AskUserQuestion')
      return askClaudeQuestion(turn.input, toolInput, { runtimeId: this.instanceId, signal: opts.signal });
    const requestId = randomUUID();
    turn.input.emit({ type: 'permission_request', requestId, toolName, input: toolInput });
    const answer = await waitAnswer(
      turn.input.requestPermission({ requestId, toolName, input: toolInput }),
      opts.signal,
    );
    turn.input.emit({ type: 'permission_resolved', requestId, decision: answer.allow ? 'allowed' : 'denied' });
    return answer.allow
      ? { behavior: 'allow', updatedInput: toolInput }
      : { behavior: 'deny', message: answer.message ?? '用户拒绝' };
  }
  private async childPermission(toolName: string, toolInput: Record<string, unknown>, id: string, signal: AbortSignal) {
    const input = this.taskOwners.get(id);
    if (!input || !this.tasks.ownsAgent(id) || !this.sessionId)
      return { behavior: 'deny' as const, message: '子代理归属尚未核实或任务已结束。' };
    const answer = await input.requestInteraction?.(
      {
        runtimeId: this.instanceId,
        scope: { kind: 'session', id: this.sessionId },
        spec: {
          kind: 'form',
          title: `子代理请求执行 ${toolName}`.slice(0, 4000),
          source: `Claude · 子代理 ${id}`,
          blocking: true,
          fields: [
            {
              id: 'allow',
              type: 'choice',
              multiple: false,
              required: true,
              label: childActionDescription(toolInput),
              options: [
                { value: 'deny', label: '拒绝' },
                { value: 'allow', label: '允许本次' },
              ],
            },
          ],
        },
      },
      { signal: AbortSignal.any([signal, this.lifetime.signal]) },
    );
    return answer?.action === 'submit' && answer.values.allow === 'allow' && this.tasks.ownsAgent(id)
      ? { behavior: 'allow' as const, updatedInput: toolInput }
      : { behavior: 'deny' as const, message: '用户未允许此子代理操作。' };
  }
}
function childActionDescription(input: Record<string, unknown>): string {
  const description = input.command ?? input.file_path ?? input.description;
  return typeof description === 'string' ? description.slice(0, 2000) : '是否允许此子代理执行本次工具调用？';
}

/** 等待网页答复；超时或被中断时拒绝 */
function waitAnswer(
  pending: Promise<{ allow: boolean; message?: string }>,
  signal: AbortSignal,
): Promise<{ allow: boolean; message?: string }> {
  if (signal.aborted) return Promise.resolve({ allow: false, message: '本轮已中断' });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (a: { allow: boolean; message?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(a);
    };
    const timer = setTimeout(() => finish({ allow: false, message: '等待确认超时，已拒绝' }), PERMISSION_TIMEOUT_MS);
    const onAbort = () => finish({ allow: false, message: '本轮已中断' });
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(finish, () => finish({ allow: false, message: '确认请求失败' }));
  });
}

function inputAcknowledgements(value: Record<string, unknown>): unknown[] {
  if (value.parent_tool_use_id || value.parent_agent_id) return [];
  if (!['stream_event', 'assistant', 'result'].includes(String(value.type))) return [];
  return Array.isArray(value.user_message_uuids) ? value.user_message_uuids : [value.user_message_uuid];
}
