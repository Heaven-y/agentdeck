import type { AgentTurnInput, TurnHandle, TurnRunner } from '../../contracts';
import { readAntigravityModelSettings, type AntigravityModelSettings } from '../model-catalog';
import { antigravityInvocationText } from '../commands';
import { AntigravityAcpClient, type AcpLaunchOptions } from './client';
import { AcpPermissions } from './permissions';
import { AcpInteractions } from './interactions';
import { acpInput, fileReference, markEmbedded } from '../../common/attachment-input';
import { AntigravityAcpMapper, acpTurnUsage } from './mapper';
import { configureSession, needsHeadless } from './selection';
import { AcpError, cancelled, object, list, protocolFailure, type AcpConnection, type AcpRecord } from './types';

type Options = {
  env?: NodeJS.ProcessEnv;
  headless: TurnRunner;
  createClient?: (options: AcpLaunchOptions) => Promise<AcpConnection>;
  settings?: () => Promise<AntigravityModelSettings>;
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
  private promptCapabilities?: AcpRecord;
  private sent = false;
  private ended = false;
  private failed?: AcpError;
  private fallback?: TurnHandle;

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
    this.permissions = new AcpPermissions(this.client, this.input, selected.id);
    this.client.onRequest = (request) => {
      if (!this.interactions?.request(request)) this.permissions?.request(request);
    };
    this.client.onNotification = (method, params) => this.notification(method, params);
    return selected.model;
  }

  private notification(method: string, params: AcpRecord): void {
    if (method === 'elicitation/complete') {
      this.interactions?.complete(params);
      return;
    }
    if (this.ended || !this.sent || method !== 'session/update') return;
    if (params.sessionId !== this.nativeId) {
      this.failed = protocolFailure();
      void this.interrupt();
      return;
    }
    try {
      for (const event of this.mapper.update(object(params.update))) this.input.emit(event);
    } catch {
      this.failed = protocolFailure();
      void this.interrupt();
    }
  }

  private async useHeadless(): Promise<void> {
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
      this.input.emit({ type: 'error', message: this.errorMessage(error) });
      this.input.emit({ type: 'turn_end', isError: true });
    } finally {
      this.ended = true;
      this.interactions?.close();
      this.permissions?.cancel();
      await this.client?.close();
    }
  }

  private errorMessage(error: unknown): string {
    if (this.failed) return this.failed.message;
    if (this.controller.signal.aborted) return '本轮已中断。';
    return error instanceof AcpError ? error.message : 'Antigravity ACP 运行失败，请核对原生配置与运行状态。';
  }
  private async selectRuntime(): Promise<string | undefined> {
    const env = this.options.env ?? process.env;
    const settings = await (this.options.settings ?? (() => readAntigravityModelSettings({ env })))();
    this.controller.signal.throwIfAborted();
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
  private validateAttachments(): void {
    if (this.input.attachments?.some((file) => file.kind === 'image') && this.promptCapabilities?.image !== true)
      throw new AcpError('selection', '当前 Antigravity 运行通道没有确认图片输入支持。');
    if (
      this.input.attachments?.some((file) => file.kind === 'text') &&
      this.promptCapabilities?.embeddedContext !== true
    )
      throw new AcpError('selection', '当前 Antigravity 运行通道没有确认文件上下文支持。');
  }
  private async prompt(model: string): Promise<void> {
    this.validateAttachments();
    const invoke =
      this.options.invocationText ??
      ((input: AgentTurnInput, signal: AbortSignal) =>
        antigravityInvocationText(input, { env: this.options.env, signal }));
    const inputText = this.input.invocation ? await invoke(this.input, this.controller.signal) : this.input.text;
    this.controller.signal.throwIfAborted();
    this.input.emit({
      type: 'session',
      sessionId: this.nativeId!,
      cwd: this.input.workspace.dir,
      model,
      agent: 'antigravity',
    });
    this.sent = true;
    const started = performance.now();
    const result = await this.client!.request(
      'session/prompt',
      { sessionId: this.nativeId!, prompt: acpInput(inputText, this.input.attachments) },
      { timeoutMs: 0 },
    );
    if (this.failed) throw this.failed;
    if (this.controller.signal.aborted || result.stopReason === 'cancelled') throw cancelled();
    const isError = result.stopReason !== 'end_turn';
    if (!isError) await markEmbedded(this.input, ['image']);
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
    return { interrupt: () => turn.interrupt(), done: turn.done.finally(() => active.delete(turn)) };
  }) as TurnRunner;
  runner.dispose = async () => {
    disposed = true;
    await Promise.all([...active].map((turn) => turn.interrupt()));
    await options.headless.dispose?.();
  };
  return runner;
}
