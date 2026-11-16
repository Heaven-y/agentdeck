import type { AgentTurnInput, TurnHandle, TurnRunner, NativeSteerInput, NativeInputResult } from '../../contracts';
import { readAntigravityModelConfig, type AntigravityModelSettings } from '../model-catalog';
import { antigravityContextWindowSnapshot } from '../context-window';
import type { NativeContextWindow } from '@agentdeck/shared/settings';
import { assertAntigravitySelection } from '../configuration/identity';
import { ModelSettingsError } from '../../common/configuration/patch';
import { antigravityInvocationText } from '../commands';
import { AntigravityAcpClient, type AcpLaunchOptions } from './client';
import { AcpPermissions } from './permissions';
import { AcpInteractions } from './interactions';
import { fileReference } from '../../common/attachment-input';
import { AcpPrompts, firstAcpInput } from './prompts';
import { AcpCommands } from './commands';
import { AntigravityAcpMapper, acpTurnUsage } from './mapper';
import { configureSession, needsHeadless } from './selection';
import { AcpError, cancelled, object, list, protocolFailure, type AcpConnection, type AcpRecord } from './types';

type Options = {
  env?: NodeJS.ProcessEnv;
  headless: TurnRunner;
  createClient?: (options: AcpLaunchOptions) => Promise<AcpConnection>;
  settings?: () => Promise<AntigravityModelSettings>;
  contextWindow?: typeof antigravityContextWindowSnapshot;
  invocationText?: (input: AgentTurnInput, signal: AbortSignal) => Promise<string>;
};

class AcpTurn {
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly mapper = new AntigravityAcpMapper();
  private client?: AcpConnection;
  private permissions?: AcpPermissions;
  private interactions?: AcpInteractions;
  private nativeId?: string;
  private contextWindow?: NativeContextWindow;
  private promptCapabilities?: AcpRecord;
  private sent = false;
  private ended = false;
  /** 本轮已流出正文：原生服务在末尾报临时故障时不能再把这一轮说成什么都没产出。 */
  private produced = false;
  private failed?: AcpError;
  private fallback?: TurnHandle;
  private prompts?: AcpPrompts;
  private readonly commands = new AcpCommands();
  private compacting = false;
  canSteer(): boolean {
    return (
      this.input.invocation?.kind !== 'acp-command' &&
      !!this.prompts?.accepting &&
      this.sent &&
      !this.ended &&
      !this.controller.signal.aborted &&
      !this.failed
    );
  }
  async steer(input: NativeSteerInput): Promise<NativeInputResult> {
    if (!this.canSteer()) return { status: 'rejected', message: '本轮已结束或当前通道不支持引导，输入已保留。' };
    try {
      this.validateAttachments(input.attachments);
      return await this.prompts!.send(input).receipt;
    } catch {
      return { status: 'rejected', message: '当前原生通道不能受理此引导，输入已保留。' };
    }
  }

  constructor(
    private readonly input: AgentTurnInput,
    private readonly options: Options,
  ) {
    this.done = this.run();
  }

  private async initialize(client: AcpConnection): Promise<AcpRecord> {
    const signal = this.controller.signal;
    const initialized = await client.request(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: { name: 'agentdeck', title: 'AgentDeck', version: '0.1.1' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          ...(this.input.requestInteraction ? { elicitation: { form: {}, url: {} } } : {}),
        },
      },
      { signal },
    );
    if (initialized.protocolVersion !== 1) throw new AcpError('unavailable', '当前 ACP 协议版本尚未适配。');
    if (!list(initialized.authMethods).some((value) => object(value).id === 'gemini-api-key'))
      throw new AcpError('unavailable', '当前 ACP 未提供 API Key 认证方式。');
    await client.request('authenticate', { methodId: 'gemini-api-key' }, { signal });
    return initialized;
  }

  private async prepare(settings: AntigravityModelSettings): Promise<string> {
    const signal = this.controller.signal;
    this.client = await (this.options.createClient ?? AntigravityAcpClient.start)({
      cwd: this.input.workspace.dir,
      env: this.options.env,
      bypass: this.input.permission?.mode === 'bypass',
    });
    signal.throwIfAborted();
    this.interactions = new AcpInteractions(this.client, this.input, () => this.nativeId);
    this.client.onNotification = (method, params) => this.notification(method, params);
    this.client.onRequest = (request) => {
      if (!this.interactions?.request(request)) this.client?.reject(request.id);
    };
    const initialized = await this.initialize(this.client);
    const capabilities = object(initialized.agentCapabilities);
    this.promptCapabilities = object(capabilities.promptCapabilities);
    const resume = object(capabilities.sessionCapabilities).resume !== undefined;
    if (this.input.sessionId && !resume) throw new AcpError('unavailable', '当前 ACP 未提供无重放续接。');
    const response = await this.client.request(
      this.input.sessionId ? 'session/resume' : 'session/new',
      {
        cwd: this.input.workspace.dir,
        mcpServers: [],
        ...(this.input.sessionId ? { sessionId: this.input.sessionId } : {}),
      },
      { signal },
    );
    const selected = await configureSession(this.client, this.input, { response, settings, signal });
    this.nativeId = selected.id;
    // ACP 已确认的是内置型号，不再拿其 ID 反查未使用的自定义别名。
    this.contextWindow = await (this.options.contextWindow ?? antigravityContextWindowSnapshot)(
      { modelProvider: settings.modelProvider },
      selected.model,
    );
    this.permissions = new AcpPermissions(this.client, this.input, selected.id);
    this.client.onRequest = (request) => {
      if (!this.interactions?.request(request)) this.permissions?.request(request);
    };
    this.client.onNotification = (method, params) => this.notification(method, params);
    return selected.model;
  }

  private notification(method: string, params: AcpRecord): void {
    if (method === 'session/update') this.commands.update(params);
    if (method === 'elicitation/complete') {
      this.interactions?.complete(params);
      return;
    }
    if (method === 'session/update') this.sessionUpdate(params);
  }
  private sessionUpdate(params: AcpRecord): void {
    if (this.ended || !this.sent) return;
    if (params.sessionId !== this.nativeId) {
      this.failed = protocolFailure();
      void this.interrupt();
      return;
    }
    try {
      this.prompts?.echo(object(params.update));
      for (const event of this.mapper.update(object(params.update))) {
        if (event.type === 'text' && event.delta) this.produced = true;
        this.input.emit(event);
      }
    } catch {
      this.failed = protocolFailure();
      void this.interrupt();
    }
  }

  private async useHeadless(): Promise<void> {
    if (this.input.invocation?.kind === 'acp-command')
      throw new AcpError('selection', '所选模型或权限使用兼容通道，不能执行ACP专用命令。');
    if (this.input.attachments?.some((file) => file.kind === 'image'))
      throw new AcpError('selection', '当前 Antigravity 兼容运行路径不支持图片，请保留附件并选择可用的 ACP 模型。');
    await this.client?.close();
    this.client = undefined;
    this.controller.signal.throwIfAborted();
    this.fallback = this.options.headless({
      ...this.input,
      text: [this.input.text, ...(this.input.attachments ?? []).map(fileReference)].filter(Boolean).join('\n\n'),
    });
    await this.fallback.done;
  }

  private async run(): Promise<void> {
    try {
      const model = await this.selectRuntime();
      if (model !== undefined) await this.prompt(model);
    } catch (error) {
      if (this.compacting)
        this.input.emit({
          type: 'compaction',
          state: { status: this.controller.signal.aborted ? 'cancelled' : 'failed', trigger: 'manual' },
        });
      this.failTurn(error);
    } finally {
      this.ended = true;
      this.prompts?.close();
      this.interactions?.close();
      this.permissions?.cancel();
      await this.client?.close();
    }
  }

  /** 可重试的服务错误在正文已流出时不代表整轮失败，只留一条可折叠记录。 */
  private failTurn(error: unknown): void {
    const message = this.errorMessage(error);
    if (error instanceof AcpError && error.retryable && this.produced && !this.controller.signal.aborted) {
      this.input.emit({
        type: 'activity',
        // 带上本轮身份：同一个会话再次超时时各轮保留自己的记录，不会被并进上一轮的位置。
        id: this.input.clientMessageId ? `agy-service-retry:${this.input.clientMessageId}` : 'agy-service-retry',
        name: '原生模型服务超时',
        status: 'completed',
        output: `${message}\n本轮已收到正文，但可能不完整；需要完整内容时可重新读取原生历史核对。`,
      });
      this.input.emit({ type: 'turn_end', isError: false });
      return;
    }
    this.input.emit({ type: 'error', message });
    this.input.emit({ type: 'turn_end', isError: true });
  }

  private errorMessage(error: unknown): string {
    if (this.failed) return this.failed.message;
    if (this.controller.signal.aborted) return '本轮已中断。';
    return error instanceof AcpError || error instanceof ModelSettingsError
      ? error.message
      : 'Antigravity ACP 运行失败，请核对原生配置与运行状态。';
  }
  private async selectRuntime(): Promise<string | undefined> {
    const env = this.options.env ?? process.env;
    const settings = await (this.options.settings ?? (() => readAntigravityModelConfig({ env })))();
    this.controller.signal.throwIfAborted();
    assertAntigravitySelection(settings, this.input.model);
    if (needsHeadless(this.input, settings, env)) {
      await this.useHeadless();
      return;
    }
    try {
      return await this.prepare(settings);
    } catch (error) {
      if (
        !(error instanceof AcpError) ||
        !['unavailable', 'selection'].includes(error.code) ||
        this.controller.signal.aborted
      )
        throw error;
      await this.useHeadless();
    }
  }
  private validateAttachments(attachments = this.input.attachments): void {
    if (attachments?.some((file) => file.kind === 'image') && this.promptCapabilities?.image !== true)
      throw new AcpError('selection', '当前 Antigravity 运行通道没有确认图片输入支持。');
    if (attachments?.some((file) => file.kind === 'text') && this.promptCapabilities?.embeddedContext !== true)
      throw new AcpError('selection', '当前 Antigravity 运行通道没有确认文件上下文支持。');
  }
  private async invocationText(): Promise<string> {
    if (this.input.invocation?.kind === 'acp-command')
      await this.commands.ready(this.nativeId!, this.controller.signal);
    const invoke =
      this.options.invocationText ??
      ((input: AgentTurnInput, signal: AbortSignal) =>
        antigravityInvocationText(input, { env: this.options.env, signal }));
    return this.input.invocation?.kind === 'acp-command'
      ? this.commands.input(this.nativeId!, this.input.invocation.name, this.input.text)
      : this.input.invocation
        ? await invoke(this.input, this.controller.signal)
        : this.input.text;
  }
  private async prompt(model: string): Promise<void> {
    this.validateAttachments();
    const inputText = await this.invocationText();
    this.controller.signal.throwIfAborted();
    this.input.emit({
      type: 'session',
      sessionId: this.nativeId!,
      cwd: this.input.workspace.dir,
      model,
      agent: 'antigravity',
      contextWindow: this.contextWindow,
    });
    this.sent = true;
    this.compacting = this.input.invocation?.kind === 'acp-command' && this.input.invocation.name === 'compact';
    if (this.compacting) this.input.emit({ type: 'compaction', state: { status: 'running', trigger: 'manual' } });
    const started = performance.now();
    this.prompts = new AcpPrompts(this.client!, this.nativeId!);
    this.prompts.send(firstAcpInput(this.input, inputText));
    const result = await this.prompts.completion();
    await this.finishPrompt(result, started);
  }
  private async finishPrompt(result: AcpRecord, started: number): Promise<void> {
    if (this.failed) throw this.failed;
    if (this.controller.signal.aborted || result.stopReason === 'cancelled') throw cancelled();
    const isError = result.stopReason !== 'end_turn';
    if (!isError) await this.prompts!.stored();
    if (this.compacting)
      this.input.emit({ type: 'compaction', state: { status: isError ? 'failed' : 'completed', trigger: 'manual' } });
    this.compacting = false;
    if (isError)
      this.input.emit({ type: 'error', message: 'Antigravity 未完整完成本轮，请检查原生停止原因或调整本轮请求。' });
    this.input.emit({
      type: 'turn_end',
      isError,
      durationMs: Math.round(performance.now() - started),
      timingSource: 'observed',
      usage: acpTurnUsage(result.usage),
    });
  }

  async interrupt(): Promise<void> {
    if (this.ended) return;
    this.controller.abort();
    this.interactions?.close();
    this.permissions?.cancel();
    if (this.fallback) {
      await this.fallback.interrupt();
      return;
    }
    if (this.client && this.nativeId) this.client.notify('session/cancel', { sessionId: this.nativeId });
    if (!this.sent) await this.client?.close();
    const timer = setTimeout(() => {
      void this.client?.close();
    }, 5000);
    try {
      await this.done;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** ACP在发送前核对模型/权限；不兼容选择沿用headless，发送后绝不回退重发。 */
export function createAntigravityAcpRunner(options: Options): TurnRunner {
  const active = new Set<AcpTurn>();
  let disposed = false;
  const runner = ((input: AgentTurnInput): TurnHandle => {
    if (disposed) throw new AcpError('unavailable', 'Antigravity 运行器已关闭。');
    const turn = new AcpTurn(input, options);
    active.add(turn);
    return {
      interrupt: () => turn.interrupt(),
      done: turn.done.finally(() => active.delete(turn)),
      canSteer: () => turn.canSteer(),
      steer: (input) => turn.steer(input),
    };
  }) as TurnRunner;
  runner.dispose = async () => {
    disposed = true;
    await Promise.all([...active].map((turn) => turn.interrupt()));
    await options.headless.dispose?.();
  };
  return runner;
}
