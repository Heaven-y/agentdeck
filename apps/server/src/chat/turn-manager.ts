// 轮次按 Agent 与原生会话隔离；耗时准备前先建立应用轮次，允许及时中断。
import { randomUUID } from 'node:crypto';
import { NativeSessionIdSchema } from '@agentdeck/shared/conversation';
import type {
  AgentEvent,
  AgentKind,
  ClientMessage,
  PermissionSelection,
  ServerMessage,
  SessionRef,
  NativeInteractionFeatures,
  ChatAttachment,
  SessionHistory,
} from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import type {
  AgentTurnInput,
  PermissionAnswer,
  TurnHandle,
  TurnRunner,
  NativeInteractionRequest,
} from '../agents/contracts';
import { InteractionHub } from './interactions';
import type { AttachmentStore, AttachmentLease } from './attachments';
import { SessionError } from '../agents/errors';
import type { CapabilitiesService } from './capabilities';
import { FollowupHost } from './followup-host';
import { RuntimeTasks } from './runtime-tasks';

export type Socket = {
  send(msg: ServerMessage): void;
  isOpen(): boolean;
  rememberInput?(message: Extract<ClientMessage, { type: 'chat.send' }>): boolean;
};
export type TurnManagerDeps = {
  getWorkspace(id: string): Promise<Workspace | undefined>;
  runners: Partial<Record<AgentKind, TurnRunner>>;
  sessions: {
    assertBelongs(ws: Workspace, agent: AgentKind, id: string, signal?: AbortSignal): Promise<Workspace | void>;
    permission?(session: SessionRef): Promise<PermissionSelection | undefined>;
    rememberPermission?(session: SessionRef, permission: PermissionSelection): Promise<void>;
    invalidate?(agent: AgentKind): void;
    read?(ws: Workspace, agent: AgentKind, id: string, signal?: AbortSignal): Promise<SessionHistory>;
  };
  capabilities?: Pick<CapabilitiesService, 'prepare'>;
  acquireWorkspace?: (id: string) => () => void;
  attachments?: AttachmentStore;
  inputFeatures?(agent: AgentKind, input: AgentTurnInput, signal: AbortSignal): Promise<NativeInteractionFeatures>;
};
type Turn = {
  id: string;
  socket: Socket;
  workspaceId: string;
  agent: AgentKind;
  controller: AbortController;
  handle?: TurnHandle;
  completion?: Promise<void>;
  sessionId?: string;
  workspace?: Workspace;
  explicitPermission?: PermissionSelection;
  sessionVerified?: boolean;
  sessionRejected?: boolean;
  finished: boolean;
  releaseWorkspace?: () => void;
  attachments?: AttachmentLease;
  attachmentEvents?: Promise<void>;
  attachmentBindingFailed?: boolean;
  hasAttachments?: boolean;
  failed?: boolean;
  nativeEnded?: boolean;
  input?: AgentTurnInput;
  startedAt: number;
  queueId?: string;
};
type Pending = { turn: Turn; resolve(answer: PermissionAnswer): void };
type Send = Extract<ClientMessage, { type: 'chat.send' }>;
const sessionKey = (agent: AgentKind, id: string) => `${agent}:${id}`;

/** 中断停止等待，同时消费仍在退出的元数据请求，避免未处理拒绝。 */
function preparing<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('本轮已中断'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class TurnManager {
  readonly interactions = new InteractionHub();
  readonly followups: FollowupHost;
  readonly tasks: RuntimeTasks;
  private turns = new Map<string, Turn>();
  private sessions = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private closed = new WeakSet<Socket>();
  private stopping = false;
  private restarting = new Set<AgentKind>();
  private readonly runners: Partial<Record<AgentKind, TurnRunner>>;

  constructor(private readonly deps: TurnManagerDeps) {
    this.runners = deps.runners;
    this.tasks = new RuntimeTasks({
      acquireWorkspace: (id) => deps.acquireWorkspace?.(id) ?? (() => {}),
      send: (owner, message) => this.send(owner, message),
    });
    this.followups = new FollowupHost({
      attachments: deps.attachments,
      acquireWorkspace: (id) => deps.acquireWorkspace?.(id) ?? (() => {}),
      send: (owner, message) => this.send(owner, message),
      active: (id) => {
        const turn = this.turns.get(id);
        return (
          turn && {
            handle: turn.handle,
            blocked:
              turn.controller.signal.aborted ||
              this.interactions.blocks(turn.socket, turn.id, turn.sessionId) ||
              [...this.pending.values()].some((pending) => pending.turn === turn),
          }
        );
      },
      dispatch: async (owner, message, source) => {
        if (owner.rememberInput && !owner.rememberInput(message)) throw new Error('恢复身份不可用或输入已登记');
        await this.start(owner, message, source);
      },
      validateSteer: async (id, assets) => {
        const turn = this.turns.get(id);
        if (!turn?.input || !this.deps.inputFeatures)
          throw new SessionError(400, 'attachment_unavailable', '当前无法确认引导附件能力，请保留输入。');
        const features = await preparing(
          this.deps.inputFeatures(turn.agent, turn.input, turn.controller.signal),
          turn.controller.signal,
        );
        validateInputFeatures(assets, features);
      },
      blocked: (owner, sessionId) => this.interactions.blocks(owner, '', sessionId),
    });
  }

  /** 该原生会话是否正被本网页占用（运行中或正在执行原生管理操作）。 */
  isRunning(session: SessionRef): boolean {
    return (
      this.sessions.has(sessionKey(session.agent, session.sessionId)) ||
      this.tasks.busy(session.agent, session.sessionId)
    );
  }

  /** 重启边界覆盖环境解析之前的项目/归属/能力准备，并排斥同时进入的新回合。 */
  async withIdleAgent<T>(agent: AgentKind, operation: () => Promise<T>): Promise<T> {
    if (
      this.stopping ||
      this.restarting.has(agent) ||
      this.followups.hasPending(agent) ||
      this.tasks.busy(agent) ||
      [...this.turns.values()].some((turn) => turn.agent === agent) ||
      [...this.sessions.keys()].some((key) => key.startsWith(`${agent}:`))
    )
      throw new SessionError(409, 'agent_busy', 'CLI 正在运行或准备，请结束后再重新启动');
    this.restarting.add(agent);
    try {
      return await operation();
    } finally {
      this.restarting.delete(agent);
    }
  }

  /** 原生管理从范围校验到写入结果全程占锁，避免与准备、运行及同步收尾交错。 */
  async withIdleSession<T>(session: SessionRef, operation: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new SessionError(503, 'server_stopping', '后端正在关闭，请稍后重试');
    if (this.restarting.has(session.agent)) throw new SessionError(409, 'agent_busy', 'CLI 正在重启或更新，请稍后重试');
    const key = sessionKey(session.agent, session.sessionId);
    if (this.sessions.has(key)) throw new SessionError(409, 'session_busy', '会话正在运行或处理其他操作，请稍后重试');
    if (this.followups.hasPending(session.agent, session.sessionId))
      throw new SessionError(409, 'session_busy', '此会话仍有待发消息，请先处理待发列表');
    if (this.tasks.busy(session.agent, session.sessionId))
      throw new SessionError(409, 'session_busy', '此会话仍有原生后台任务，请先完成或停止。');
    const owner = randomUUID();
    this.sessions.set(key, owner);
    try {
      return await operation();
    } finally {
      if (this.sessions.get(key) === owner) this.sessions.delete(key);
    }
  }

  async handle(socket: Socket, msg: ClientMessage): Promise<void> {
    if (isFollowupAction(msg)) return this.followups.handle(socket, msg);
    if (msg.type === 'task.stop') return this.stopTask(socket, msg);
    switch (msg.type) {
      case 'question.respond':
        return this.answerQuestion(socket, msg);
      case 'interaction.respond':
        this.interactions.respond(socket, msg.id, msg.answer);
        return;
      case 'chat.send':
        return this.start(socket, msg);
      case 'chat.interrupt':
        return this.interruptTurn(socket, msg.turnId);
      case 'permission.respond':
        return this.respond(socket, msg);
    }
  }
  private async stopTask(socket: Socket, message: Extract<ClientMessage, { type: 'task.stop' }>): Promise<void> {
    try {
      await this.tasks.stop(socket, message);
    } catch {
      this.send(socket, {
        type: 'task.error',
        runtimeId: message.runtimeId,
        taskId: message.taskId,
        message: '任务已结束或不属于当前页面的活动实例，请刷新状态后核对。',
      });
    }
  }
  private async interruptTurn(socket: Socket, turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.socket !== socket) return;
    turn.controller.abort();
    this.followups.pause(turn.id);
    await turn.handle?.interrupt();
  }

  private async answerQuestion(
    socket: Socket,
    msg: Extract<ClientMessage, { type: 'question.respond' }>,
  ): Promise<void> {
    try {
      if (this.closed.has(socket) || this.stopping) throw new Error('连接已关闭');
      await this.followups.answerQuestion(socket, msg, async () => {
        if (!this.deps.sessions.read) throw new Error('不可读取原生问题');
        const release = this.deps.acquireWorkspace?.(msg.workspaceId);
        try {
          const signal = AbortSignal.timeout(30_000);
          const ws = await preparing(this.deps.getWorkspace(msg.workspaceId), signal);
          if (!ws) throw new Error('工作区不可用');
          const history = await preparing(this.deps.sessions.read(ws, msg.agent, msg.sessionId, signal), signal);
          if (this.closed.has(socket) || this.stopping) throw new Error('连接已关闭');
          const event = history.events.find(
            (event) =>
              event.type === 'async_question' &&
              event.question.messageId === msg.messageId &&
              event.question.sessionId === msg.sessionId,
          );
          if (event?.type !== 'async_question')
            throw new SessionError(404, 'question_missing', '未在此原生会话找到该提问，请重新读取历史。');
          return event;
        } finally {
          release?.();
        }
      });
    } catch (error) {
      this.send(socket, {
        type: 'question.error',
        workspaceId: msg.workspaceId,
        agent: msg.agent,
        sessionId: msg.sessionId,
        messageId: msg.messageId,
        message: error instanceof SessionError ? error.message : '未能提交回答，请保留内容并核对原生会话。',
      });
    }
  }

  socketClosed(socket: Socket): void {
    void this.tasks.closeOwner(socket);
    this.followups.discard(socket);
    this.interactions.cancelChannel(socket);
    this.closed.add(socket);
    for (const [id, pending] of this.pending) {
      if (pending.turn.socket === socket) {
        this.pending.delete(id);
        pending.resolve({ allow: false, message: '网页连接已断开' });
      }
    }
    for (const turn of this.turns.values()) {
      if (turn.socket !== socket) continue;
      turn.controller.abort();
      void turn.handle?.interrupt().catch(() => undefined);
    }
  }
  socketOffline(socket: Socket): void {
    this.followups.offline(socket);
  }

  /** 退出后端时停止本进程拥有的轮次，并关闭长驻运行时。 */
  async dispose(): Promise<void> {
    this.stopping = true;
    this.followups.dispose();
    this.interactions.dispose();
    const pending: Promise<unknown>[] = [this.tasks.dispose()];
    for (const turn of this.turns.values()) {
      this.followups.discard(turn.socket);
      this.closed.add(turn.socket);
      turn.controller.abort();
      if (turn.handle) pending.push(turn.handle.interrupt(), turn.completion ?? turn.handle.done);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 原生退出后的权限保存和解锁也属于本轮收尾，关闭不能在 done 时提前返回。
    const stopped = Promise.allSettled(pending);
    try {
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 6000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // 运行时长驻时随其关闭一并停止。
      await Promise.allSettled(Object.values(this.runners).map((runner) => runner?.dispose?.() ?? Promise.resolve()));
    }
  }

  private send(socket: Socket, msg: ServerMessage): void {
    if (!this.closed.has(socket) && socket.isOpen()) socket.send(msg);
  }

  private respond(socket: Socket, msg: Extract<ClientMessage, { type: 'permission.respond' }>): void {
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.turn.id !== msg.turnId || pending.turn.socket !== socket) return;
    if (pending.turn.controller.signal.aborted) return;
    this.pending.delete(msg.requestId);
    pending.resolve({ allow: msg.allow, message: msg.message });
  }

  private bindSession(turn: Turn, id: string): boolean {
    const key = sessionKey(turn.agent, id);
    const occupied = this.sessions.get(key);
    if ((turn.sessionId && turn.sessionId !== id) || (occupied && occupied !== turn.id)) {
      this.rejectSession(turn);
      return false;
    }
    turn.sessionId = id;
    this.sessions.set(key, turn.id);
    return true;
  }

  private rejectSession(turn: Turn): void {
    turn.sessionRejected = true;
    this.send(turn.socket, { type: 'error', turnId: turn.id, message: '原生会话身份发生变化，已停止本轮' });
    turn.controller.abort();
    void turn.handle?.interrupt().catch(() => undefined);
  }

  private event(turn: Turn, event: AgentEvent): void {
    if (event.type === 'session' && !this.acceptSessionEvent(turn, event)) return;
    if (turn.attachmentEvents) {
      turn.attachmentEvents = turn.attachmentEvents.then(() => this.deliverEvent(turn, event));
      return;
    }
    if (event.type === 'session') {
      turn.attachmentEvents = this.bindAttachments(turn, event);
      return;
    }
    this.deliverEvent(turn, event);
  }
  private async bindAttachments(turn: Turn, event: Extract<AgentEvent, { type: 'session' }>): Promise<void> {
    try {
      // event已同步核验并占用原生会话；磁盘绑定期间其他页面不能抢占。
      await turn.attachments?.bind(event.sessionId);
      await this.followups.bind(turn.id, event.sessionId);
      this.deliverEvent(turn, event);
    } catch {
      turn.attachmentBindingFailed = true;
      turn.failed = true;
      turn.controller.abort();
      const message = '附件未能绑定原生会话，本轮已停止；请核对原生历史后恢复文字与附件。';
      this.send(turn.socket, { type: 'input.rejected', turnId: turn.id, message });
      this.send(turn.socket, { type: 'error', turnId: turn.id, message });
      this.send(turn.socket, { type: 'agent.event', turnId: turn.id, event: { type: 'turn_end', isError: true } });
      void turn.handle?.interrupt().catch(() => undefined);
    }
  }
  private deliverEvent(turn: Turn, event: AgentEvent): void {
    if (turn.attachmentBindingFailed) return;
    if (turn.finished) return;
    if (!this.acceptQuestionEvent(turn, event)) return;
    if (event.type === 'session') {
      if (!this.acceptSessionEvent(turn, event)) return;
      event = { ...event, agent: turn.agent };
    }
    this.updateEventState(turn, event);
    this.send(turn.socket, { type: 'agent.event', turnId: turn.id, event });
    if (
      new Set(['permission_request', 'permission_resolved', 'interaction_request', 'interaction_resolved']).has(
        event.type,
      )
    )
      this.followups.changed(turn.id);
  }
  private acceptQuestionEvent(turn: Turn, event: AgentEvent): boolean {
    if (event.type !== 'async_question') return true;
    if (turn.agent !== 'codex' || event.question.sessionId !== turn.sessionId) return false;
    this.followups.observeQuestion(turn.id, event.question);
    return true;
  }
  private updateEventState(turn: Turn, event: AgentEvent): void {
    if (event.type === 'turn_end') {
      turn.nativeEnded = true;
      if (event.isError) turn.failed = true;
    }
    if (event.type === 'permission_resolved') {
      const pending = this.pending.get(event.requestId);
      if (pending?.turn === turn) {
        this.pending.delete(event.requestId);
        pending.resolve({ allow: false, message: '原生确认请求已结束' });
      }
    }
  }

  private acceptSessionEvent(turn: Turn, event: Extract<AgentEvent, { type: 'session' }>): boolean {
    if (!NativeSessionIdSchema.safeParse(event.sessionId).success || (event.agent && event.agent !== turn.agent)) {
      this.rejectSession(turn);
      return false;
    }
    this.deps.sessions.invalidate?.(turn.agent);
    return this.bindSession(turn, event.sessionId);
  }

  private permission(turn: Turn, req: Parameters<AgentTurnInput['requestPermission']>[0]): Promise<PermissionAnswer> {
    if (turn.controller.signal.aborted || turn.finished || this.closed.has(turn.socket))
      return Promise.resolve({ allow: false, message: '本轮或连接已结束' });
    return new Promise((resolve) => this.pending.set(req.requestId, { turn, resolve }));
  }

  private acquireWorkspace(socket: Socket, msg: Send): { release?: () => void } | undefined {
    try {
      return { release: this.deps.acquireWorkspace?.(msg.workspaceId) };
    } catch {
      this.send(socket, {
        type: 'error',
        clientTurnId: msg.clientTurnId,
        message: '工作区当前不可用，请刷新后重试',
      });
      return;
    }
  }

  private preparationFailed(turn: Turn, error: unknown) {
    turn.failed = true;
    if (turn.hasAttachments && !turn.handle)
      this.send(turn.socket, {
        type: 'input.rejected',
        turnId: turn.id,
        message: error instanceof SessionError ? error.message : '无法确认附件输入能力，请保留附件并稍后重试。',
      });
    if (!turn.controller.signal.aborted)
      this.send(turn.socket, {
        type: 'error',
        turnId: turn.id,
        message: error instanceof SessionError ? error.message : 'Agent 调用失败，请检查本机运行时和配置',
      });
  }

  private async start(socket: Socket, msg: Send, source?: { queueId: string; clientMessageId: string }): Promise<void> {
    if (this.closed.has(socket)) return;
    if (!this.taskOwnerAvailable(socket, msg)) return;
    const reason = this.startRestriction(msg, !!source);
    if (reason) {
      this.send(socket, { type: 'error', clientTurnId: msg.clientTurnId, message: reason });
      return;
    }
    const agent = msg.agent;
    const key = msg.sessionId && sessionKey(agent, msg.sessionId);
    const lease = this.acquireWorkspace(socket, msg);
    if (!lease) return;
    const turn: Turn = {
      id: randomUUID(),
      socket,
      agent,
      workspaceId: msg.workspaceId,
      sessionId: msg.sessionId,
      controller: new AbortController(),
      finished: false,
      startedAt: Date.now(),
      releaseWorkspace: lease.release,
      hasAttachments: hasAttachments(msg),
    };
    if (!this.registerQueue(turn, msg, source)) return;
    this.turns.set(turn.id, turn);
    if (key) this.sessions.set(key, turn.id);
    this.send(socket, {
      type: 'turn.started',
      turnId: turn.id,
      clientTurnId: msg.clientTurnId,
      workspaceId: msg.workspaceId,
      agent,
      queueId: turn.queueId,
      ...(source ? { followupClientMessageId: source.clientMessageId, input: msg } : {}),
    });
    try {
      await this.prepare(turn, msg);
    } catch (error) {
      this.preparationFailed(turn, error);
      this.finish(turn);
    }
  }
  private registerQueue(turn: Turn, msg: Send, source?: { queueId: string; clientMessageId: string }): boolean {
    try {
      turn.queueId = this.followups.register(turn.socket, msg, turn.id, source);
      if (!this.closed.has(turn.socket)) return true;
    } catch {
      this.send(turn.socket, {
        type: 'error',
        clientTurnId: msg.clientTurnId,
        message: '无法创建待发列表，请检查页面容量或重新连接。',
      });
    }
    turn.releaseWorkspace?.();
    return false;
  }
  private taskOwnerAvailable(socket: Socket, msg: Send): boolean {
    if (!msg.sessionId || !this.tasks.ownedBusy(socket, msg.agent, msg.sessionId)) return true;
    this.send(socket, {
      type: 'error',
      clientTurnId: msg.clientTurnId,
      message: '此原生会话的后台任务仍由另一页面持有，请回到原页面操作。',
    });
    return false;
  }
  private startRestriction(msg: Send, followup: boolean): string | undefined {
    if (this.stopping) return '后端正在关闭，请稍后重试';
    if (this.restarting.has(msg.agent)) return 'CLI 正在重启或更新，请稍后重试';
    if (!msg.sessionId) return;
    if (!followup && this.followups.hasPending(msg.agent, msg.sessionId))
      return '该会话仍有待发消息，请先继续或清空待发列表。';
    if (this.sessions.has(sessionKey(msg.agent, msg.sessionId))) return '该会话正在运行';
  }

  private async prepare(turn: Turn, msg: Send): Promise<void> {
    const { signal } = turn.controller;
    let ws = await preparing(this.deps.getWorkspace(msg.workspaceId), signal);
    if (!ws) throw new SessionError(404, 'workspace_missing', '工作区不存在');
    const projectDir = ws.dir;
    if (msg.sessionId) {
      ws = (await preparing(this.deps.sessions.assertBelongs(ws, turn.agent, msg.sessionId, signal), signal)) ?? ws;
      turn.sessionVerified = true;
    }
    turn.workspace = ws;
    const permission = await this.selectedPermission(turn, msg);
    turn.explicitPermission = msg.permission;
    if (msg.selection && !this.deps.capabilities)
      throw new SessionError(503, 'capabilities_unavailable', '当前原生能力不可用');
    const prepared = this.deps.capabilities
      ? await preparing(this.deps.capabilities.prepare(ws, turn.agent, msg, signal), signal)
      : { text: msg.text, invocation: undefined };
    signal.throwIfAborted();
    const runner = this.runners[turn.agent];
    if (!runner) throw new SessionError(503, 'agent_unavailable', '当前 Agent 适配器不可用');
    const input: AgentTurnInput = {
      workspace: ws,
      projectDir,
      sessionId: msg.sessionId,
      model: msg.model,
      reasoningEffort: msg.reasoningEffort,
      collaborationMode: msg.collaborationMode,
      permission,
      text: prepared.text,
      clientMessageId: nativeInputId(msg.clientTurnId),
      onInputAccepted: () => this.followups.accepted(turn.id),
      invocation: prepared.invocation,
      emit: (event) => this.event(turn, event),
      requestPermission: (req) => this.permission(turn, req),
      requestInteraction: (request, options) => this.interaction(turn, request, options),
      completeInteraction: (runtimeId, id) => this.interactions.complete(turn.socket, runtimeId, id),
      registerRuntime: (control) => {
        if (this.closed.has(turn.socket) || this.stopping) {
          void control.close?.();
          return;
        }
        this.tasks.register(turn.socket, { workspaceId: turn.workspaceId, agent: turn.agent }, control);
      },
    };
    if (hasAttachments(msg)) await this.prepareAttachments(turn, msg, input);
    signal.throwIfAborted();
    turn.input = input;
    turn.handle = runner(input);
    this.followups.changed(turn.id);
    if (signal.aborted) void turn.handle.interrupt();
    turn.completion = turn.handle.done
      .catch(() => {
        turn.failed = true;
        this.send(turn.socket, { type: 'error', turnId: turn.id, message: 'Agent 运行失败，请检查本机运行时和配置' });
      })
      .then(() => turn.attachmentEvents)
      .then(() => this.rememberPermission(turn))
      .then(() => this.finish(turn));
  }
  private async prepareAttachments(turn: Turn, msg: Send, input: AgentTurnInput): Promise<void> {
    if (!this.deps.attachments || !this.deps.inputFeatures || !msg.conversationId)
      throw new SessionError(400, 'attachment_unavailable', '当前附件输入不可用，请重新连接。');
    if (input.invocation && input.invocation.kind !== 'skill')
      throw new SessionError(400, 'attachment_unavailable', '原生命令不能附带文件，请先移除附件。');
    const scope = {
      workspaceId: msg.workspaceId,
      agent: msg.agent,
      conversationId: msg.conversationId,
      sessionId: msg.sessionId,
    };
    const assets = await this.deps.attachments.inspect(turn.socket, scope, msg.attachments!);
    const features = await preparing(
      this.deps.inputFeatures(turn.agent, input, turn.controller.signal),
      turn.controller.signal,
    );
    validateInputFeatures(assets, features);
    const lease = await this.deps.attachments.acquire(turn.socket, scope, msg.attachments!);
    turn.attachments = lease;
    input.attachments = lease.files;
    input.attachmentsStored = (ids) => lease.stored(ids);
    this.event(turn, { type: 'input_attachments', attachments: assets });
  }

  private interaction(turn: Turn, request: NativeInteractionRequest, options?: { signal?: AbortSignal }) {
    const owner = { ...(request.scope ?? { kind: 'turn' as const, id: turn.id }), runtimeId: request.runtimeId };
    if (this.closed.has(turn.socket) || this.stopping || (owner.kind === 'turn' && turn.finished))
      return Promise.resolve({ action: 'cancel' as const });
    const signal = interactionSignal(owner.kind, turn.controller.signal, options?.signal);
    return this.interactions.request(
      {
        channel: turn.socket,
        owner,
        completionId: request.completionId,
        emit: (event) => {
          if (owner.kind === 'turn') this.event(turn, event);
          else
            this.send(turn.socket, {
              type: 'interaction.event',
              workspaceId: turn.workspaceId,
              agent: turn.agent,
              sessionId: turn.sessionId,
              event,
            });
          this.followups.changed(turn.id);
        },
      },
      contextualInteraction(request.spec, turn),
      { signal },
    );
  }

  private async selectedPermission(turn: Turn, msg: Send): Promise<PermissionSelection | undefined> {
    let permission = msg.permission;
    if (permission === undefined && msg.sessionId && this.deps.sessions.permission)
      permission = await preparing(
        this.readSavedPermission({ agent: turn.agent, sessionId: msg.sessionId }),
        turn.controller.signal,
      );
    if (permission && permission.agent !== turn.agent)
      throw new SessionError(400, 'permission_agent_mismatch', '权限模式不属于当前 CLI');
    return permission;
  }

  private async readSavedPermission(session: SessionRef): Promise<PermissionSelection | undefined> {
    try {
      return await this.deps.sessions.permission!(session);
    } catch {
      throw new SessionError(503, 'session_permission_unavailable', '会话权限读取失败，请重新读取权限后再发送。');
    }
  }

  private async rememberPermission(turn: Turn): Promise<void> {
    if (turn.attachmentBindingFailed) return;
    if (turn.sessionRejected || !turn.explicitPermission || !turn.sessionId || !this.deps.sessions.rememberPermission)
      return;
    try {
      // 新会话只接受运行器提供的原生身份，完成后再查原生索引核对项目归属。
      if (!turn.sessionVerified) await this.deps.sessions.assertBelongs(turn.workspace!, turn.agent, turn.sessionId);
      await this.deps.sessions.rememberPermission(
        { agent: turn.agent, sessionId: turn.sessionId },
        turn.explicitPermission,
      );
    } catch {
      this.send(turn.socket, {
        type: 'error',
        turnId: turn.id,
        message: '会话权限未保存，请稍后重新选择。',
      });
    }
  }

  private finish(turn: Turn): void {
    if (turn.finished) return;
    // 会话/管理操作交互独立生存，只结束本轮所属的问题。
    this.interactions.cancelTurn(turn.id);
    turn.finished = true;
    this.deps.sessions.invalidate?.(turn.agent);
    for (const [id, pending] of this.pending) {
      if (pending.turn === turn) {
        this.pending.delete(id);
        pending.resolve({ allow: false, message: '本轮已结束' });
      }
    }
    this.turns.delete(turn.id);
    const key = turn.sessionId && sessionKey(turn.agent, turn.sessionId);
    if (key && this.sessions.get(key) === turn.id) this.sessions.delete(key);
    turn.releaseWorkspace?.();
    turn.attachments?.release();
    turn.attachments = undefined;
    turn.input = undefined;
    this.send(turn.socket, {
      type: 'turn.finished',
      turnId: turn.id,
      workspaceId: turn.workspaceId,
      agent: turn.agent,
    });
    this.followups.finished(turn.id, {
      success: nativeSucceeded(turn),
      attempted: !!turn.handle,
    });
  }
}
function contextualInteraction(spec: NativeInteractionRequest['spec'], turn: Turn): NativeInteractionRequest['spec'] {
  const cli = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }[turn.agent];
  return { ...spec, source: [cli, turn.workspace?.name, spec.source].filter(Boolean).join(' · ').slice(0, 200) };
}

function interactionSignal(kind: string, turn: AbortSignal, signal?: AbortSignal): AbortSignal | undefined {
  if (kind !== 'turn') return signal;
  return signal ? AbortSignal.any([turn, signal]) : turn;
}

function hasAttachments(message: Send): boolean {
  return !!message.attachments?.length;
}
function nativeInputId(id: string): string {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ? id : randomUUID();
}
function nativeSucceeded(turn: Turn): boolean {
  return !!turn.nativeEnded && !turn.failed && !turn.controller.signal.aborted && !turn.sessionRejected;
}
function isFollowupAction(message: ClientMessage): message is Parameters<FollowupHost['handle']>[1] {
  return new Set(['chat.followup', 'followup.edit', 'followup.cancel', 'followup.clear', 'followup.resume']).has(
    message.type,
  );
}
function validateInputFeatures(assets: ChatAttachment[], features: NativeInteractionFeatures): void {
  if (assets.some((file) => file.kind === 'image') && !features.images.available)
    throw new SessionError(400, 'attachment_unavailable', features.images.reason ?? '当前模型或运行通道不支持图片。');
  if (assets.some((file) => file.kind !== 'image') && !features.documents.available)
    throw new SessionError(
      400,
      'attachment_unavailable',
      features.documents.reason ?? '当前运行通道不支持文件上下文。',
    );
}
