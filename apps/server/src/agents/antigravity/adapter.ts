import { antigravityPermissionArgs } from './run/permissions';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import type { AgentTurnInput, TurnHandle, TurnRunner } from '../contracts';
import { resolveLocalCommand } from '../../platform/process/executable';
import { AntigravityMapper } from './run/mapper';
import { AntigravityLines } from './run/lines';
import {
  antigravityLaunchSelection,
  AntigravityModelSelectionError,
  type AntigravityLaunchSelection,
} from './models/model-launch';
import { AntigravityInvocationError, antigravityInvocationText, isAntigravityCompact } from './commands/commands';
import {
  ANTIGRAVITY_EMPTY_REPLY,
  ANTIGRAVITY_TURN_FAILED,
  antigravityDiagnostic,
  rateLimitOnlyFailure,
  transientServiceFailure,
} from './run/diagnostics';
import { antigravityBackgroundEnvironment } from './run/process-environment';
import { reviewAntigravityCurrentTurn, type CurrentTurnReview, type TrajectoryReader } from './commands/completion';
import type { AgentEvent } from '@agentdeck/shared/conversation';
import { createAntigravityAcpRunner } from './acp/runtime';
import { prepareNativeSettings } from './models/native-settings-override';

export type AntigravityProcess = Pick<
  ChildProcessWithoutNullStreams,
  'stdin' | 'stdout' | 'stderr' | 'kill' | 'on' | 'once'
>;
type LaunchInput = { cwd: string; args: string[]; env?: NodeJS.ProcessEnv };
/**
 * 服务错误后允许的最长静默：实测 524 之后 agy 会挂住，既不重试也不退出。
 * 只在已经出现可重试服务故障时计时，正常的长任务不受影响。
 */
const STALL_AFTER_SERVICE_ERROR_MS = 3 * 60 * 1000;
type Options = {
  launch?: (input: LaunchInput) => AntigravityProcess;
  env?: NodeJS.ProcessEnv;
  defaultModel?: (requested?: string) => Promise<string | undefined>;
  selectModel?: (requested?: string, reasoningEffort?: string) => Promise<AntigravityLaunchSelection>;
  invocationText?: (input: AgentTurnInput, signal: AbortSignal) => Promise<string>;
  readTrajectory?: TrajectoryReader;
};
type TurnServices = {
  invocationText: NonNullable<Options['invocationText']>;
  readTrajectory?: TrajectoryReader;
};
type ModelResolver = (
  requested?: string,
  reasoningEffort?: string,
) => Promise<AntigravityLaunchSelection | string | undefined>;
const launchSelectionValue = (value: Awaited<ReturnType<ModelResolver>>): AntigravityLaunchSelection =>
  typeof value === 'string' ? { model: value } : (value ?? {});
const resolveSelection = (resolve: ModelResolver, input: AgentTurnInput) =>
  input.reasoningEffort ? resolve(input.model, input.reasoningEffort) : resolve(input.model);

function startFailure(error: unknown): string {
  return error instanceof AntigravityInvocationError || error instanceof AntigravityModelSelectionError
    ? error.message
    : '无法启动 Antigravity，请检查本机 agy 安装与启动环境。';
}
function launch(input: LaunchInput): AntigravityProcess {
  const executable = resolveLocalCommand('agy', input.env ?? process.env);
  return spawn(executable.command, [...executable.args, ...input.args], {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function argumentsFor(input: AgentTurnInput, selection: AntigravityLaunchSelection, settings?: string): string[] {
  const model = selection.model ?? input.model;
  const effort = selection.modelSetsEffort ? undefined : (input.reasoningEffort ?? selection.defaultReasoningEffort);
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (input.sessionId) args.push('--conversation', input.sessionId);
  if (model) args.push('--model', model);
  if (settings) args.push('--settings', settings);
  if (effort) args.push('--effort', effort);
  args.push(...antigravityPermissionArgs(input.permission));
  return args;
}

type FailureEvent = Extract<AgentEvent, { type: 'error' }>;
type ResultExit = 'success' | 'native-failure' | 'cleanup' | 'abnormal';

/** 每轮关闭 stdin，下一轮以原生 id 续接；不保存第二份会话正文。 */
class AntigravityTurn {
  readonly done: Promise<void>;
  private settle!: () => void;
  private readonly mapper: AntigravityMapper;
  private readonly stdout: AntigravityLines;
  private readonly stderr: AntigravityLines;
  private child?: AntigravityProcess;
  private timer?: NodeJS.Timeout;
  private ended = false;
  private finishing = false;
  private failed = false;
  private readonly notices = new Set<string>();
  private observedFailure?: FailureEvent;
  private reportedFailure = false;
  private nativeFailure = false;
  /** 服务型故障先暂存：原生可能已自行重试成功，本轮结束前不写成永久错误。 */
  private pendingService?: { event: FailureEvent; only429: boolean };
  /** 服务错误后长期没有任何输出时收尾：agy 会挂住既不重试也不退出。 */
  private stallTimer?: NodeJS.Timeout;
  /** 原生结果已经确认时，进程清理与模型回合成功是两个独立状态。 */
  private closingAfterResult = false;
  private cleanupSignalSent = false;
  private readonly cleanupSignals = new Set<NodeJS.Signals>();
  private readonly preparation = new AbortController();
  private selection?: AntigravityLaunchSelection;
  private nativeSettings?: Awaited<ReturnType<typeof prepareNativeSettings>>;

  constructor(
    private readonly input: AgentTurnInput,
    start: (input: LaunchInput) => AntigravityProcess,
    defaultModel: ModelResolver,
    private readonly services: TurnServices,
  ) {
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.mapper = new AntigravityMapper(input.workspace.dir, input.sessionId);
    this.stdout = new AntigravityLines((line) => this.message(line));
    this.stderr = new AntigravityLines((line) => this.diagnostic(line), 65_536);
    void this.start(start, defaultModel, services.invocationText);
  }

  private async start(
    start: (input: LaunchInput) => AntigravityProcess,
    defaultModel: ModelResolver,
    invocationText: (input: AgentTurnInput, signal: AbortSignal) => Promise<string>,
  ) {
    try {
      const text = this.input.invocation ? await invocationText(this.input, this.preparation.signal) : this.input.text;
      // 显式选择也要翻译应用键，确保命中对应的原生自定义条目。
      const selection = await resolveSelection(defaultModel, this.input);
      this.selection = launchSelectionValue(selection);
      if (this.selection.nativeSettings)
        this.nativeSettings = await prepareNativeSettings(this.selection.nativeSettings);
      if (this.preparation.signal.aborted) {
        await this.nativeSettings?.close();
        return;
      }
      this.child = start({
        cwd: this.input.workspace.dir,
        args: argumentsFor(this.input, this.selection, this.nativeSettings?.path),
      });
      this.listen(this.child);
      this.timer = setTimeout(() => this.fail('Antigravity 启动超时，请检查本机登录与配置。'), 30_000);
      if (isAntigravityCompact(this.input.invocation))
        this.input.emit({ type: 'compaction', state: { status: 'running', trigger: 'manual' } });
      this.child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: text } })}\n`);
    } catch (error) {
      this.fail(startFailure(error));
      if (!this.child) void this.finish(null);
    }
  }

  interrupt(): Promise<void> {
    if (!this.ended) {
      this.failed = true;
      this.preparation.abort();
      if (this.child && !this.finishing) this.stop();
      else if (!this.finishing) void this.finish(null);
    }
    return this.done;
  }

  private listen(child: AntigravityProcess): void {
    child.stdout.on('data', (chunk: Buffer) => this.consume(this.stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => this.consume(this.stderr, chunk));
    child.stdin.on('error', () => this.fail('Antigravity 未接收本轮输入。'));
    child.once('error', () => this.fail('Antigravity 进程启动失败，请检查安装与执行路径。'));
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => void this.finish(code, signal));
  }

  private consume(lines: AntigravityLines, chunk: Buffer): void {
    if (this.ended || this.finishing || this.failed) return;
    // 原生仍在输出说明没有挂住，重新计时。
    if (this.stallTimer) this.armStall();
    try {
      lines.push(chunk);
    } catch {
      this.fail('Antigravity 输出格式异常或超限，已停止本轮。');
    }
  }

  /**
   * 只在出现可重试的服务故障后启用：实测 524 之后 agy 既不重试也不退出，
   * 二十多分钟没有任何请求。正常回合不受影响，长任务也不会被总时长误杀。
   */
  private armStall(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.ended || this.finishing || this.failed || this.mapper.result) return;
      this.fail(this.observedFailure?.message ?? this.pendingService?.event.message ?? ANTIGRAVITY_TURN_FAILED);
    }, STALL_AFTER_SERVICE_ERROR_MS);
    this.stallTimer.unref();
  }

  private message(line: string): void {
    if (this.ended || this.failed) return;
    const value: unknown = JSON.parse(line);
    const events = this.mapper.map(value);
    if (events.some((event) => event.type === 'session') || this.mapper.result) clearTimeout(this.timer);
    for (const event of events) {
      if (event.type === 'error') this.notice(event);
      else this.emit(event);
    }
    if (this.mapper.result)
      this.timer = setTimeout(() => {
        this.closingAfterResult = true;
        this.stop();
      }, 2_000);
  }

  private emit(event: AgentEvent): void {
    if (event.type === 'compaction' && isAntigravityCompact(this.input.invocation)) {
      if (this.mapper.hasCurrentCompaction) this.input.emit({ ...event, state: { ...event.state, trigger: 'manual' } });
      return;
    }
    if (event.type === 'session') this.emitSession(event);
    else this.input.emit(event);
  }

  private emitSession(event: Extract<AgentEvent, { type: 'session' }>): void {
    if (this.selection) {
      const alias = this.selection.sessionModel !== undefined;
      const matchesAlias = alias && event.model === this.selection.model;
      const model = matchesAlias ? this.selection.sessionModel! : event.model;
      const contextWindow =
        alias && !matchesAlias
          ? (event.contextWindow ?? { model: event.model })
          : (this.selection.contextWindow ?? event.contextWindow);
      this.input.emit({
        ...event,
        model,
        ...(contextWindow ? { contextWindow } : {}),
      });
    } else this.input.emit(event);
  }

  private diagnostic(line: string): void {
    const event = antigravityDiagnostic(line);
    // 服务型故障不代表本轮一定失败：先暂存，等回合结束再按是否有结果决定报不报。
    if (event?.type === 'error' && transientServiceFailure(line)) {
      this.deferService(line, event);
      return;
    }
    this.nativeFailure ||=
      event?.type === 'error' || /^(?:error\s*:|AGY_ERROR\s*:)/i.test(stripVTControlCharacters(line).trim());
    if (event) this.notice(event);
  }

  private deferService(line: string, event: FailureEvent): void {
    const only429 = rateLimitOnlyFailure(line);
    if (!this.pendingService || this.pendingService.only429 || !only429) this.pendingService = { event, only429 };
    this.armStall();
  }

  private notice(event: Extract<AgentEvent, { type: 'error' | 'activity' }>): void {
    if (event.type === 'error') {
      this.observedFailure = event;
      return;
    }
    if (this.notices.has(event.id)) return;
    this.notices.add(event.id);
    this.input.emit(event);
  }

  private showFailure(event: FailureEvent): void {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    this.input.emit(event);
  }

  private fail(message: string): void {
    if (this.ended || this.failed) return;
    this.failed = true;
    this.showFailure({ type: 'error', message });
    this.stop();
  }

  private stop(): void {
    clearTimeout(this.timer);
    clearTimeout(this.stallTimer);
    this.kill('SIGTERM');
    this.timer = setTimeout(() => {
      this.kill('SIGKILL');
      // kill 只表示信号已发送，真实 close 才能释放会话占用与活动实例。
    }, 2_000);
  }

  private kill(signal: NodeJS.Signals): void {
    const sent = this.child?.kill(signal);
    if (sent && this.closingAfterResult) {
      this.cleanupSignalSent = true;
      this.cleanupSignals.add(signal);
    }
  }

  private cleanupExit(code: number | null, signal: NodeJS.Signals | null): boolean {
    return this.cleanupSignalSent && (code === 0 || (code === null && !!signal && this.cleanupSignals.has(signal)));
  }

  private abnormalExit(code: number | null, signal: NodeJS.Signals | null): boolean {
    return code !== 0 && !this.cleanupExit(code, signal);
  }

  private flushOutput(): void {
    if (this.failed) return;
    try {
      this.stdout.end();
      this.stderr.end();
    } catch {
      this.failed = true;
      this.showFailure({ type: 'error', message: 'Antigravity 结束时返回了不完整的协议数据。' });
    }
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null = null): Promise<void> {
    if (this.ended || this.finishing) return;
    this.finishing = true;
    try {
      this.flushOutput();
      clearTimeout(this.timer);
      await this.completeResult(code, signal);
      this.finishTurn(code, signal);
    } finally {
      this.ended = true;
      await this.nativeSettings?.close().catch(() => undefined);
      this.settle();
    }
  }

  private finishTurn(code: number | null, signal: NodeJS.Signals | null): void {
    const nativeResult = this.mapper.result;
    const result: Extract<AgentEvent, { type: 'turn_end' }> = nativeResult ?? { type: 'turn_end', isError: true };
    const failed = this.failed || result.isError || this.abnormalExit(code, signal);
    const emptyReply = !failed && this.hasEmptyReply();
    const missingCompaction = this.finishCompaction(failed);
    const isError = failed || emptyReply || missingCompaction;
    if (result.outcome !== 'unconfirmed') {
      if (isError) this.reportFailure(nativeResult, emptyReply);
      else if (this.observedFailure) this.showFailure(this.observedFailure);
    }
    this.input.emit({ ...result, isError });
  }

  private finishCompaction(failed: boolean): boolean {
    if (!isAntigravityCompact(this.input.invocation) || this.mapper.hasCurrentCompaction) return false;
    this.input.emit({
      type: 'compaction',
      state: { status: this.preparation.signal.aborted ? 'cancelled' : 'failed', trigger: 'manual' },
    });
    if (!failed) this.showFailure({ type: 'error', message: 'AGY 未报告本次压缩完成，请重新读取会话查看。' });
    return true;
  }

  private hasEmptyReply(): boolean {
    return !this.input.invocation && !this.mapper.hasReply && !this.observedFailure;
  }

  private reportFailure(result: Extract<AgentEvent, { type: 'turn_end' }> | undefined, emptyReply: boolean): void {
    if (this.reportedFailure) return;
    const diagnostic = this.primaryFailure(result?.isError === true);
    if (diagnostic) this.showFailure(diagnostic);
    else if (!this.failed) this.showFailure({ type: 'error', message: this.failureFallback(!!result, emptyReply) });
  }

  private primaryFailure(nativeFailed: boolean): FailureEvent | undefined {
    if (this.observedFailure) return this.observedFailure;
    const pending = this.pendingService;
    const terminal = nativeFailed && !this.failed ? this.mapper.resultDiagnostic : undefined;
    // 同轮已确认的错误优先；纯 429 不能盖过最终明确原因。
    if (terminal?.type === 'error' && (!this.mapper.rateLimitedResult || pending?.only429 !== false)) return terminal;
    return pending?.event;
  }

  private failureFallback(hasResult: boolean, emptyReply: boolean): string {
    if (emptyReply && !this.nativeFailure && !this.mapper.currentStepFailure) return ANTIGRAVITY_EMPTY_REPLY;
    return hasResult ? ANTIGRAVITY_TURN_FAILED : 'Antigravity 提前退出，回复可能不完整。可重新读取会话查看已保存内容。';
  }

  private resultExit(code: number | null, signal: NodeJS.Signals | null): ResultExit {
    if (this.cleanupExit(code, signal)) return 'cleanup';
    if (signal || this.cleanupSignalSent) return 'abnormal';
    if (code === 0) return 'success';
    return code === 3 ? 'native-failure' : 'abnormal';
  }

  private async completeResult(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (!this.mapper.result?.isError || this.failed || this.observedFailure || this.hasDecisiveFailure()) return;
    const exit = this.resultExit(code, signal);
    const review = exit === 'success' || exit === 'native-failure' ? await this.reviewCompletion() : undefined;
    if (!this.failed) this.applyCompletion(review, exit);
  }

  private hasDecisiveFailure(): boolean {
    return this.nativeFailure || this.pendingService?.only429 === false;
  }

  private applyCompletion(review: CurrentTurnReview | undefined, exit: ResultExit): void {
    if (review?.status === 'error') {
      this.observedFailure = { type: 'error', message: review.message };
      return;
    }
    if (review?.status !== 'completed' || this.mapper.terminalFailure || exit !== 'success') return;
    if (review.recoveredRateLimit && this.mapper.canRecoverCompletion) {
      for (const event of this.mapper.confirmCompletion(review)) this.emit(event);
    } else this.resolveHistoricalConflict(review);
  }

  private resolveHistoricalConflict(completed: Extract<CurrentTurnReview, { status: 'completed' }>): void {
    if (!this.mapper.resumedResultError || !completed.historicalErrorMatch) return;
    if (this.pendingService && !completed.verifiedCompletion) {
      // 本轮实际报告的故障未恢复；不能让与旧轮同文的 result 掩盖它。
      this.observedFailure = this.pendingService.event;
    } else {
      // 同文不证明本轮成功，也不足以把旧错误贴到新回复上。
      for (const event of this.mapper.markUnconfirmed(completed)) this.emit(event);
    }
  }

  private reviewCompletion(): Promise<CurrentTurnReview> | undefined {
    const boundary = this.mapper.completionBoundary();
    if (!boundary || !this.services.readTrajectory) return undefined;
    if (this.pendingService) boundary.rateLimitedResult = true;
    return reviewAntigravityCurrentTurn(
      this.services.readTrajectory,
      { sessionId: boundary.sessionId, cwd: this.input.workspace.dir, boundary },
      this.preparation.signal,
    );
  }
}

export function createAntigravityHeadlessRunner(options: Options = {}): TurnRunner {
  const active = new Set<AntigravityTurn>();
  const runner: TurnRunner = (input): TurnHandle => {
    const turn = new AntigravityTurn(
      input,
      (request) =>
        (options.launch ?? launch)({ ...request, env: antigravityBackgroundEnvironment(options.env ?? process.env) }),
      options.selectModel ??
        options.defaultModel ??
        ((requested, effort) =>
          antigravityLaunchSelection(options.env ?? process.env, requested, undefined, { explicitEffort: effort })),
      {
        invocationText:
          options.invocationText ?? ((input, signal) => antigravityInvocationText(input, { env: options.env, signal })),
        readTrajectory: options.readTrajectory,
      },
    );
    active.add(turn);
    return { interrupt: () => turn.interrupt(), done: turn.done.finally(() => active.delete(turn)) };
  };
  runner.dispose = async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([...active].map((turn) => turn.interrupt())),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2_100);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return runner;
}

/** 注入旧流进程的受控调用仍走headless；正式运行按原生模型与协议选择接入。 */
export function createAntigravityRunner(options: Options = {}): TurnRunner {
  const headless = createAntigravityHeadlessRunner(options);
  if (options.launch) return headless;
  return createAntigravityAcpRunner({ env: options.env, headless, invocationText: options.invocationText });
}
