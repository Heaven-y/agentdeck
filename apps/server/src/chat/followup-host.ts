import { randomUUID } from 'node:crypto';
import type {
  ClientMessage,
  FollowupContent,
  FollowupContext,
  FollowupItem,
  FollowupSnapshot,
  AgentKind,
  ChatAttachment,
  AsyncQuestion,
  ServerMessage,
} from '@agentdeck/shared/conversation';
import type { TurnHandle } from '../agents/contracts';
import { SessionError } from '../agents/errors';
import { FollowupQueue } from './followup-queue';
import type { AttachmentStore, AttachmentHold, AttachmentLease } from './attachments';
import type { Socket } from './turn-manager';
import { FollowupQuestions } from './followup-questions';
import { FollowupSteering } from './followup-steering';
import { FollowupAnswerGate, followupQuestionIdentity } from './followup-answer-gate';

type Send = Extract<ClientMessage, { type: 'chat.send' }>;
type Action = Extract<
  ClientMessage,
  { type: 'chat.followup' | 'followup.edit' | 'followup.cancel' | 'followup.clear' | 'followup.resume' }
>;
export type FollowupGroup = {
  owner: Socket;
  context: FollowupContext;
  template: FollowupChoices;
  turnId?: string;
  inputId?: string;
  busy: Promise<void>;
  leases: Map<string, AttachmentHold>;
  runningAssets: AttachmentLease[];
  questions: FollowupQuestions;
  releaseWorkspace?: () => void;
  leaseDepth: number;
};
export type FollowupHostDeps = {
  attachments?: AttachmentStore;
  send(
    owner: Socket,
    message: Extract<ServerMessage, { type: 'followup.state' | 'followup.error' | 'followup.delivered' }>,
  ): void;
  active(id: string): { handle?: TurnHandle; blocked: boolean } | undefined;
  dispatch(owner: Socket, message: Send, source: { queueId: string; clientMessageId: string }): Promise<void>;
  validateSteer(id: string, assets: ChatAttachment[]): Promise<void>;
  blocked?(owner: Socket, sessionId?: string): boolean;
  acquireWorkspace?(id: string): () => void;
};
const conflict = (message: string) => new SessionError(409, 'followup_conflict', message);
type FollowupChoices = Pick<FollowupContent, 'model' | 'reasoningEffort' | 'permission' | 'collaborationMode'>;
const choices = (input: FollowupChoices) =>
  JSON.stringify([
    input.model ?? '',
    input.reasoningEffort ?? '',
    input.permission?.mode ?? '',
    input.collaborationMode ?? '',
  ]);

/** 将会话队列与轮次、附件租约连接；原生受理未知时保留暂停记录，绝不换路径重投。 */
type FollowupOutcome = { success: boolean; attempted: boolean; unconfirmed?: boolean };

export class FollowupHost {
  private readonly groups = new Map<string, FollowupGroup>();
  private readonly queue: FollowupQueue;
  private readonly steering: FollowupSteering;
  private readonly answers = new FollowupAnswerGate();
  private readonly offlineOwners = new WeakSet<Socket>();
  constructor(private readonly deps: FollowupHostDeps) {
    this.queue = new FollowupQueue({ onChange: (_owner, state) => this.publish(state.queueId) });
    this.steering = new FollowupSteering(deps, this.queue, (group) => this.groups.get(group.context.queueId) === group);
  }
  register(
    owner: Socket,
    message: Send,
    turnId?: string,
    source?: { queueId: string; clientMessageId: string },
  ): string {
    let group = source ? this.owned(owner, source.queueId) : this.matching(owner, message);
    if (!group) {
      const context = {
        queueId: randomUUID(),
        workspaceId: message.workspaceId,
        agent: message.agent,
        conversationId: message.conversationId ?? message.clientTurnId,
        sessionId: message.sessionId,
      };
      group = {
        owner,
        context,
        template: inputChoices(message),
        turnId,
        busy: Promise.resolve(),
        leases: new Map(),
        runningAssets: [],
        questions: new FollowupQuestions(),
        leaseDepth: 0,
      };
      this.queue.register(owner, context);
      this.groups.set(context.queueId, group);
    }
    group.template = inputChoices(message);
    group.turnId = turnId;
    group.inputId = source?.clientMessageId;
    if (!source && !this.queue.hasPending(group.context.agent, group.context.sessionId))
      this.queue.resume(owner, group.context.queueId);
    this.pauseOffline(group);
    return group.context.queueId;
  }
  private matching(owner: Socket, message: Send): FollowupGroup | undefined {
    return [...this.groups.values()].find(
      (group) =>
        group.owner === owner &&
        group.context.workspaceId === message.workspaceId &&
        group.context.agent === message.agent &&
        (message.sessionId
          ? group.context.sessionId === message.sessionId
          : group.context.conversationId === message.conversationId),
    );
  }
  private owned(owner: Socket, id: string): FollowupGroup {
    const group = this.groups.get(id);
    if (!group || group.owner !== owner) throw conflict('待发列表不属于当前页面或已失效。');
    return group;
  }
  private forTurn(id: string): FollowupGroup | undefined {
    return [...this.groups.values()].find((group) => group.turnId === id);
  }
  private publish(id: string): void {
    const group = this.groups.get(id);
    if (!group) return;
    this.releaseIdleWorkspace(group);
    const snapshot = this.snapshot(group);
    this.answers.observe(id, group.context, snapshot.questions ?? []);
    this.deps.send(group.owner, { type: 'followup.state', snapshot });
  }
  private releaseIdleWorkspace(group: FollowupGroup): void {
    if (group.leaseDepth) return;
    if (
      this.queue
        .snapshot(group.owner, group.context.queueId)
        .items.some((item) => !['accepted', 'cancelled'].includes(item.status))
    )
      return;
    group.releaseWorkspace?.();
    group.releaseWorkspace = undefined;
  }
  private async withQueueLease<T>(group: FollowupGroup, operation: () => Promise<T>): Promise<T> {
    this.assertScheduler(group);
    group.releaseWorkspace ??= this.deps.acquireWorkspace?.(group.context.workspaceId);
    group.leaseDepth++;
    try {
      return await operation();
    } finally {
      group.leaseDepth--;
      if (this.groups.has(group.context.queueId)) this.releaseIdleWorkspace(group);
    }
  }
  private assertScheduler(group: FollowupGroup): void {
    if (!group.context.sessionId) return;
    for (const other of this.groups.values()) {
      if (
        other === group ||
        other.context.agent !== group.context.agent ||
        other.context.sessionId !== group.context.sessionId
      )
        continue;
      if (
        this.queue
          .snapshot(other.owner, other.context.queueId)
          .items.some((item) => !['accepted', 'cancelled'].includes(item.status))
      )
        throw conflict('该原生会话在另一个待发列表中仍有消息，请先处理原列表。');
    }
  }
  private snapshot(group: FollowupGroup): FollowupSnapshot {
    const active = group.turnId ? this.deps.active(group.turnId) : undefined;
    const state = this.queue.snapshot(group.owner, group.context.queueId);
    return {
      ...state,
      questions: group.questions.snapshot(state.items),
      activeTurnId: group.turnId,
      canSteer: !state.paused && !!active?.handle?.canSteer?.() && !active.blocked,
    };
  }
  snapshots(owner: Socket): FollowupSnapshot[] {
    return [...this.groups.values()].filter((group) => group.owner === owner).map((group) => this.snapshot(group));
  }
  async bind(turnId: string, sessionId: string): Promise<void> {
    const group = this.forTurn(turnId);
    if (!group || group.context.sessionId === sessionId) return;
    const work = group.busy.then(async () => {
      group.context.sessionId = sessionId;
      this.queue.bind(group.owner, group.context.queueId, sessionId);
      for (const [id, hold] of group.leases) {
        try {
          await hold.bind(sessionId);
        } catch {
          this.queue.result(group.owner, group.context.queueId, id, {
            status: 'failed',
            reason: '附件未绑定到新会话，请移除并恢复文件后重传。',
          });
        }
      }
    });
    group.busy = work.catch(() => undefined);
    await work;
  }
  accepted(turnId: string): void {
    const group = this.forTurn(turnId);
    if (!group) return;
    if (group.inputId) this.queue.result(group.owner, group.context.queueId, group.inputId, { status: 'accepted' });
    this.publish(group.context.queueId);
  }
  changed(turnId: string): void {
    const group = this.forTurn(turnId);
    if (!group) return;
    if (
      this.deps.active(turnId)?.blocked &&
      this.queue.snapshot(group.owner, group.context.queueId).items.some((item) => item.status === 'queued')
    )
      this.queue.pause(group.owner, group.context.queueId, '本轮正在等待答复，待发列表已暂停；处理后可继续。');
    this.publish(group.context.queueId);
  }
  observeQuestion(turnId: string, question: AsyncQuestion): void {
    const group = this.forTurn(turnId);
    if (group?.context.agent !== 'codex' || group.context.sessionId !== question.sessionId) return;
    group.questions.observeLive(question);
    this.publish(group.context.queueId);
  }
  async answerQuestion(
    owner: Socket,
    message: Extract<ClientMessage, { type: 'question.respond' }>,
    read: () => Promise<{ question: AsyncQuestion; answered?: boolean }>,
  ): Promise<void> {
    return this.answers.run(followupQuestionIdentity(message, message.messageId), () =>
      this.answerLocked(owner, message, read),
    );
  }
  private async answerLocked(
    owner: Socket,
    message: Extract<ClientMessage, { type: 'question.respond' }>,
    read: () => Promise<{ question: AsyncQuestion; answered?: boolean }>,
  ): Promise<void> {
    const template: Send = {
      type: 'chat.send',
      workspaceId: message.workspaceId,
      agent: message.agent,
      conversationId: message.conversationId,
      sessionId: message.sessionId,
      text: '',
      clientTurnId: randomUUID(),
      model: message.model,
      reasoningEffort: message.reasoningEffort,
      collaborationMode: message.collaborationMode,
      permission: message.permission,
    };
    const target = await this.questionGroup(owner, template, message, read);
    const receipt = this.answers.get(followupQuestionIdentity(message, message.messageId));
    if (receipt?.status === 'accepted')
      target.questions.observe(target.questions.get(message.messageId)!.question, true);
    else if (receipt && receipt.queueId !== target.context.queueId && receipt.status !== 'cancelled')
      throw conflict('此问题已有未核实的答复，请先核对原页面的待发列表与原生历史。');
    const work = target.busy.then(() =>
      this.withQueueLease(target, async () => {
        if (!this.groups.has(target.context.queueId)) throw conflict('连接已失效，请重新读取原生历史。');
        const answer = target.questions.prepare(message.messageId, message.answer);
        if (answer) {
          const content = {
            text: answer.text,
            model: message.model,
            reasoningEffort: message.reasoningEffort,
            collaborationMode: message.collaborationMode,
            permission: message.permission,
          };
          await this.add(target, {
            type: 'chat.followup',
            queueId: target.context.queueId,
            clientMessageId: answer.clientMessageId,
            mode: 'queue',
            content,
          });
          this.answers.claim(
            followupQuestionIdentity(target.context, message.messageId),
            target.context.queueId,
            'queued',
          );
          target.questions.submitted(message.messageId, answer.clientMessageId);
          await this.pump(target);
        }
        this.publish(target.context.queueId);
      }),
    );
    target.busy = work.catch(() => undefined);
    await work;
  }
  private async questionGroup(
    owner: Socket,
    template: Send,
    message: Extract<ClientMessage, { type: 'question.respond' }>,
    read: () => Promise<{ question: AsyncQuestion; answered?: boolean }>,
  ) {
    let group = this.matching(owner, template);
    if (group?.questions.isLive(message.messageId) && group.turnId) return group;
    const native = await read();
    if (native.question.sessionId !== message.sessionId || native.question.messageId !== message.messageId)
      throw conflict('原生提问身份不匹配。');
    group = this.matching(owner, template) ?? this.owned(owner, this.register(owner, template));
    group.questions.observe(native.question, native.answered);
    return group;
  }
  finished(turnId: string, outcome: FollowupOutcome): void {
    const group = this.forTurn(turnId);
    if (!group) return;
    this.finishInput(group, outcome);
    for (const lease of group.runningAssets.splice(0)) lease.release();
    group.turnId = undefined;
    group.inputId = undefined;
    group.questions.endTurn();
    if (!outcome.success)
      this.queue.pause(
        group.owner,
        group.context.queueId,
        outcome.unconfirmed ? '本轮原生结果未确认，待发列表已暂停。' : '本轮失败或停止，待发列表已暂停。',
      );
    this.publish(group.context.queueId);
    if (outcome.success) void this.pump(group);
  }
  private finishInput(group: FollowupGroup, outcome: FollowupOutcome): void {
    const id = group.inputId;
    if (id) {
      const item = this.queue
        .snapshot(group.owner, group.context.queueId)
        .items.find((item) => item.clientMessageId === id);
      if (item?.status === 'dispatching')
        this.queue.result(
          group.owner,
          group.context.queueId,
          id,
          outcome.success
            ? { status: 'accepted' }
            : {
                status: outcome.attempted ? 'unknown' : 'failed',
                reason: outcome.unconfirmed
                  ? '本轮原生结果未确认，请核对历史；待发列表已暂停。'
                  : '本轮未完成，请核对历史；待发列表已暂停。',
              },
        );
      group.leases.get(id)?.release();
      group.leases.delete(id);
    }
  }
  hasPending(agent: AgentKind, sessionId?: string): boolean {
    return this.queue.hasPending(agent, sessionId);
  }
  offline(owner: Socket): void {
    this.offlineOwners.add(owner);
    this.queue.pauseOwner(owner, '连接已断开，待发列表已暂停；恢复连接后可继续。');
  }
  private pauseOffline(group: FollowupGroup): void {
    if (this.offlineOwners.has(group.owner))
      this.queue.pause(group.owner, group.context.queueId, '连接已断开，待发列表已暂停；恢复连接后可继续。');
  }
  pause(turnId: string): void {
    const group = this.forTurn(turnId);
    if (group) this.queue.pause(group.owner, group.context.queueId, '本轮已停止，待发列表已暂停。');
  }
  dispose(): void {
    for (const owner of new Set([...this.groups.values()].map((group) => group.owner))) this.discard(owner);
  }
  discard(owner: Socket): void {
    for (const group of this.groups.values())
      if (group.owner === owner) {
        this.answers.discard(group.context.queueId);
        for (const lease of group.leases.values()) lease.release();
        for (const lease of group.runningAssets) lease.release();
        group.releaseWorkspace?.();
        this.groups.delete(group.context.queueId);
      }
    this.queue.discardOwner(owner);
  }
  async handle(owner: Socket, message: Action): Promise<void> {
    if (message.type === 'followup.resume') this.offlineOwners.delete(owner);
    let group: FollowupGroup;
    try {
      group = this.owned(owner, message.queueId);
    } catch (error) {
      this.error(owner, message, error);
      return;
    }
    const run = group.busy.then(() => this.action(group, message));
    group.busy = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      this.error(owner, message, error);
    }
  }
  private error(owner: Socket, message: Action, error: unknown): void {
    this.deps.send(owner, {
      type: 'followup.error',
      queueId: message.queueId,
      ...('clientMessageId' in message ? { clientMessageId: message.clientMessageId } : {}),
      message: error instanceof SessionError ? error.message : '追加消息未受理，请保留输入并核对当前状态。',
    });
  }
  private async action(group: FollowupGroup, message: Action): Promise<void> {
    const { owner, context } = group,
      id = context.queueId;
    if (!this.groups.has(id)) throw conflict('待发列表已失效。');
    switch (message.type) {
      case 'chat.followup':
        return this.withQueueLease(group, () => this.add(group, message));
      case 'followup.edit': {
        const hold = await this.hold(group, message.content);
        try {
          this.queue.edit(owner, id, message.clientMessageId, { revision: message.revision, content: message.content });
        } catch (error) {
          hold?.release();
          throw error;
        }
        this.replaceHold(group, message.clientMessageId, hold);
        return;
      }
      case 'followup.cancel':
        this.queue.cancel(owner, id, message.clientMessageId, message.revision);
        this.replaceHold(group, message.clientMessageId);
        this.publish(id);
        return;
      case 'followup.clear':
        for (const key of this.queue.clear(owner, id)) this.replaceHold(group, key);
        return;
      case 'followup.resume':
        this.queue.resume(owner, id);
        return this.pump(group);
    }
  }
  private async hold(group: FollowupGroup, content: FollowupContent): Promise<AttachmentHold | undefined> {
    if (!content.attachments?.length) return;
    if (!this.deps.attachments) throw conflict('当前附件输入不可用。');
    return this.deps.attachments.hold(group.owner, group.context, content.attachments);
  }
  private replaceHold(group: FollowupGroup, id: string, hold?: AttachmentHold): void {
    group.leases.get(id)?.release();
    group.leases.delete(id);
    if (!this.groups.has(group.context.queueId)) {
      hold?.release();
      return;
    }
    if (hold) group.leases.set(id, hold);
  }
  private async add(group: FollowupGroup, message: Extract<Action, { type: 'chat.followup' }>): Promise<void> {
    const known = this.queue
      .snapshot(group.owner, group.context.queueId)
      .items.some((item) => item.clientMessageId === message.clientMessageId);
    if (known) {
      this.queue.add(group.owner, group.context.queueId, message);
      this.publish(group.context.queueId);
      return;
    }
    if (message.mode === 'steer') this.assertSteer(group, message);
    const hold = await this.hold(group, message.content);
    let item: FollowupItem;
    try {
      item = this.queue.add(group.owner, group.context.queueId, message);
    } catch (error) {
      hold?.release();
      throw error;
    }
    this.replaceHold(group, item.clientMessageId, hold);
    if (!this.groups.has(group.context.queueId)) return;
    if (message.mode === 'steer') await this.steer(group, item);
    else {
      if (group.turnId && this.deps.active(group.turnId)?.blocked)
        this.queue.pause(group.owner, group.context.queueId, '本轮正在等待答复，待发列表已暂停；处理后可继续。');
      await this.pump(group);
    }
  }
  private assertSteer(group: FollowupGroup, message: Extract<Action, { type: 'chat.followup' }>): void {
    if (this.queue.snapshot(group.owner, group.context.queueId).paused)
      throw conflict('待发列表已暂停，请先核对后继续。');
    this.assertSteerTarget(group, message.turnId);
    if (message.content.selection || choices(message.content) !== choices(group.template))
      throw conflict('引导不能切换模型、权限或附带原生技能命令，请使用排队发送。');
  }
  private assertSteerTarget(group: FollowupGroup, turnId?: string): void {
    const active = group.turnId ? this.deps.active(group.turnId) : undefined;
    if (!active?.handle?.canSteer?.() || turnId !== group.turnId || active.blocked)
      throw conflict('本轮已结束、尚未准备好或正在等待答复，请保留输入。');
  }
  private async steer(group: FollowupGroup, item: FollowupItem): Promise<void> {
    await this.steering.run(group, item);
    await this.pump(group);
  }
  private async pump(group: FollowupGroup): Promise<void> {
    this.pauseOffline(group);
    if (group.turnId || !this.groups.has(group.context.queueId)) return;
    if (this.deps.blocked?.(group.owner, group.context.sessionId)) {
      this.queue.pause(group.owner, group.context.queueId, '此会话正在等待答复，请处理后再继续待发列表。');
      return;
    }
    const item = this.queue.next(group.owner, group.context.queueId);
    if (!item?.content) return;
    if (!group.context.sessionId) {
      this.queue.result(group.owner, group.context.queueId, item.clientMessageId, {
        status: 'failed',
        reason: '原生会话尚未创建，请核对后重新发送。',
      });
      return;
    }
    const message: Send = {
      type: 'chat.send',
      ...item.content,
      workspaceId: group.context.workspaceId,
      agent: group.context.agent,
      conversationId: group.context.conversationId,
      sessionId: group.context.sessionId,
      clientTurnId: randomUUID(),
    };
    try {
      await this.deps.dispatch(group.owner, message, {
        queueId: group.context.queueId,
        clientMessageId: item.clientMessageId,
      });
    } catch {
      /* 未开始的输入按下方实际状态保留，不重投。 */
    }
    this.dispatchFailed(group, item);
  }
  private dispatchFailed(group: FollowupGroup, item: FollowupItem): void {
    if (
      this.groups.has(group.context.queueId) &&
      !group.turnId &&
      this.queue
        .snapshot(group.owner, group.context.queueId)
        .items.find((value) => value.clientMessageId === item.clientMessageId)?.status === 'dispatching'
    )
      this.queue.result(group.owner, group.context.queueId, item.clientMessageId, {
        status: 'failed',
        reason: '本轮未能开始，输入已保留。',
      });
  }
}
function inputChoices({ model, reasoningEffort, permission, collaborationMode }: FollowupChoices): FollowupChoices {
  return { model, reasoningEffort, permission, collaborationMode };
}
