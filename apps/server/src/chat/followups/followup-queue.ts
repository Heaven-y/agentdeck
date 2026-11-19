import { createHash } from 'node:crypto';
import {
  FOLLOWUP_LIMITS,
  FollowupContentSchema,
  type FollowupContent,
  type FollowupContext,
  type FollowupItem,
  type FollowupMode,
  type FollowupSnapshot,
  type FollowupStatus,
} from '@agentdeck/shared/conversation';
import { SessionError } from '../../agents/errors';

type Entry = FollowupItem & { digest: string; expiresAt?: number };
type Group = {
  owner: object;
  context: FollowupContext;
  revision: number;
  paused: boolean;
  reason?: string;
  items: Entry[];
};
type Options = { now?: () => number; onChange?(owner: object, state: FollowupSnapshot): void };
type Input = { clientMessageId: string; mode: FollowupMode; content: FollowupContent };
type ItemVersion = Pick<FollowupItem, 'clientMessageId' | 'revision'>;
const failure = (message: string) => new SessionError(409, 'followup_conflict', message);
const terminal = (item: Entry) => item.status === 'accepted' || item.status === 'cancelled';
const publicItem = ({ digest: _digest, expiresAt: _expiresAt, ...item }: Entry): FollowupItem => structuredClone(item);
const digest = (mode: FollowupMode, content: FollowupContent) =>
  createHash('sha256').update(JSON.stringify({ mode, content })).digest('hex');

/** 队列和回执独立于旧轮次缓存；只保留元数据与有界待发输入，不持久化或在重启后重发。 */
export class FollowupQueue {
  private readonly groups = new Map<string, Group>();
  private readonly receipts = new Map<object, Map<string, { group: Group; item: Entry }>>();
  private readonly now: () => number;
  constructor(private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
  }

  register(owner: object, context: FollowupContext): void {
    const existing = this.groups.get(context.queueId);
    if (existing) {
      if (
        existing.owner !== owner ||
        existing.context.workspaceId !== context.workspaceId ||
        existing.context.agent !== context.agent ||
        existing.context.conversationId !== context.conversationId
      )
        throw failure('队列不属于当前页面或会话。');
      return;
    }
    if ([...this.groups.values()].filter((group) => group.owner === owner).length >= FOLLOWUP_LIMITS.ownerReceipts)
      throw failure('此页面队列记录达到上限，请关闭不再使用的会话。');
    this.groups.set(context.queueId, { owner, context: { ...context }, revision: 0, paused: false, items: [] });
  }
  private group(owner: object, id: string): Group {
    const group = this.groups.get(id);
    if (!group || group.owner !== owner) throw failure('队列不属于当前页面或已失效。');
    return group;
  }
  private entry(group: Group, id: string, revision?: number): Entry {
    const item = group.items.find((item) => item.clientMessageId === id);
    if (!item) throw failure('追加消息不存在。');
    if (revision !== undefined && item.revision !== revision) throw failure('追加消息版本已变化，请使用最新状态。');
    return item;
  }
  private changed(group: Group): void {
    const pending = group.items.some((item) => !terminal(item));
    for (const item of group.items)
      if (terminal(item)) {
        if (pending) item.expiresAt = undefined;
        else item.expiresAt ??= this.now() + FOLLOWUP_LIMITS.receiptMs;
      }
    group.revision++;
    this.options.onChange?.(group.owner, this.snapshot(group.owner, group.context.queueId));
  }
  snapshot(owner: object, id: string): FollowupSnapshot {
    const group = this.group(owner, id);
    return {
      ...group.context,
      revision: group.revision,
      paused: group.paused,
      reason: group.reason,
      items: group.items.map(publicItem),
    };
  }
  snapshots(owner: object): FollowupSnapshot[] {
    return [...this.groups.values()]
      .filter((group) => group.owner === owner)
      .map((group) => this.snapshot(owner, group.context.queueId));
  }
  bind(owner: object, id: string, sessionId: string): void {
    const group = this.group(owner, id);
    if (group.context.sessionId && group.context.sessionId !== sessionId) throw failure('原生会话身份不匹配。');
    if (group.context.sessionId === sessionId) return;
    group.context.sessionId = sessionId;
    this.changed(group);
  }
  add(owner: object, id: string, input: Input): FollowupItem {
    this.prune();
    const group = this.group(owner, id),
      content = FollowupContentSchema.parse(input.content);
    if (content.permission && content.permission.agent !== group.context.agent) throw failure('权限模式不属于此CLI。');
    if (content.collaborationMode && group.context.agent !== 'codex') throw failure('协作模式仅用于Codex。');
    const fingerprint = digest(input.mode, content),
      known = this.receipts.get(owner)?.get(input.clientMessageId);
    if (known) {
      if (known.group !== group || known.item.digest !== fingerprint) throw failure('此消息ID已用于其他内容或会话。');
      return publicItem(known.item);
    }
    this.capacity(group);
    const item: Entry = {
      clientMessageId: input.clientMessageId,
      revision: 0,
      mode: input.mode,
      status: 'queued',
      text: content.text.slice(0, 256),
      content,
      digest: fingerprint,
    };
    group.items.push(item);
    let receipts = this.receipts.get(owner);
    if (!receipts) {
      receipts = new Map();
      this.receipts.set(owner, receipts);
    }
    receipts.set(item.clientMessageId, { group, item });
    this.changed(group);
    return publicItem(item);
  }
  private capacity(group: Group): void {
    const pending = (items: Entry[]) => items.filter((item) => !terminal(item)).length;
    if (
      pending(group.items) >= FOLLOWUP_LIMITS.perConversation ||
      [...this.groups.values()].reduce((sum, group) => sum + pending(group.items), 0) >= FOLLOWUP_LIMITS.totalPending
    )
      throw failure('待发消息已达到上限：每会话10条、宿主合计100条。');
    if ((this.receipts.get(group.owner)?.size ?? 0) >= FOLLOWUP_LIMITS.ownerReceipts)
      throw failure('此页面追加消息回执达到上限，请稍后再试。');
  }
  edit(
    owner: object,
    id: string,
    messageId: string,
    change: { revision: number; content: FollowupContent },
  ): FollowupItem {
    const group = this.group(owner, id),
      item = this.entry(group, messageId, change.revision);
    if (item.mode === 'steer') throw failure('引导记录不能重新投递，请核对后移除记录，再显式排队发送。');
    if (!['queued', 'failed'].includes(item.status)) throw failure('已投递或受理未确认的消息不能编辑或重发。');
    const next = FollowupContentSchema.parse(change.content);
    if (next.collaborationMode && group.context.agent !== 'codex') throw failure('协作模式仅用于Codex。');
    if (next.permission && next.permission.agent !== group.context.agent) throw failure('权限模式不属于此CLI。');
    item.content = next;
    item.text = next.text.slice(0, 256);
    item.status = 'queued';
    item.reason = undefined;
    item.revision++;
    this.changed(group);
    return publicItem(item);
  }
  cancel(
    owner: object,
    id: string,
    { clientMessageId, revision, returnToDraft }: ItemVersion & { returnToDraft?: true },
  ): void {
    const group = this.group(owner, id),
      item = this.entry(group, clientMessageId, revision);
    if (returnToDraft && (item.mode !== 'queue' || !['queued', 'failed'].includes(item.status)))
      throw failure('待发状态已变化，不能取回编辑。');
    if (returnToDraft) item.returnedToDraft = true;
    if (item.status === 'dispatching' || item.status === 'accepted')
      throw failure('消息已投递，不能作为待发消息撤回。');
    this.setResult(
      item,
      'cancelled',
      item.status === 'unknown' ? '已移除记录；不撤销原生可能收到的内容，也不会重发。' : undefined,
    );
    this.changed(group);
  }
  clear(owner: object, id: string): string[] {
    const group = this.group(owner, id),
      cancelled: string[] = [];
    for (const item of group.items)
      if (item.status === 'queued' || item.status === 'failed') {
        this.setResult(item, 'cancelled');
        cancelled.push(item.clientMessageId);
      }
    this.changed(group);
    return cancelled;
  }
  next(owner: object, id: string): FollowupItem | undefined {
    const group = this.group(owner, id);
    if (group.paused || group.items.some((item) => ['dispatching', 'unknown', 'failed'].includes(item.status))) return;
    const item = group.items.find((item) => item.status === 'queued' && item.mode === 'queue');
    return item && this.claim(group, item);
  }
  promoteToSteer(
    owner: object,
    id: string,
    { clientMessageId, revision }: ItemVersion,
    validate: (content: FollowupContent) => void,
  ): FollowupItem {
    const group = this.group(owner, id),
      item = this.entry(group, clientMessageId, revision);
    if (group.paused || item.mode !== 'queue' || item.status !== 'queued' || !item.content)
      throw failure('待发状态已变化，不能引导本轮。');
    validate(item.content);
    // 先从下一轮调度中摘出，再异步调用原生接口；保持原消息 ID 与回执指纹。
    item.mode = 'steer';
    item.revision++;
    this.changed(group);
    return publicItem(item);
  }
  claimSteer(owner: object, id: string, messageId: string): FollowupItem {
    const group = this.group(owner, id),
      item = this.entry(group, messageId);
    if (group.paused || item.mode !== 'steer' || item.status !== 'queued')
      throw failure('当前不能引导本轮，请保留输入。');
    return this.claim(group, item);
  }
  private claim(group: Group, item: Entry): FollowupItem {
    item.status = 'dispatching';
    item.revision++;
    this.changed(group);
    return publicItem(item);
  }
  result(
    owner: object,
    id: string,
    messageId: string,
    outcome: { status: 'accepted' | 'failed' | 'unknown'; reason?: string },
  ): void {
    const { status, reason } = outcome;
    const group = this.group(owner, id),
      item = this.entry(group, messageId);
    if (terminal(item)) return;
    // 原生迟到的权威确认可以收敛unknown，不能令已取消项再次投递。
    this.setResult(item, status, reason);
    if (status !== 'accepted') {
      group.paused = true;
      group.reason = reason ?? '追加消息未成功受理，请检查后再继续。';
    }
    this.changed(group);
  }
  private setResult(item: Entry, status: FollowupStatus, reason?: string): void {
    item.status = status;
    item.reason = reason;
    item.revision++;
    if (terminal(item)) {
      item.content = undefined;
    }
  }
  pause(owner: object, id: string, reason: string): void {
    const group = this.group(owner, id);
    group.paused = true;
    group.reason = reason;
    this.changed(group);
  }
  pauseOwner(owner: object, reason: string): void {
    for (const group of this.groups.values())
      if (group.owner === owner) this.pause(owner, group.context.queueId, reason);
  }
  resume(owner: object, id: string): void {
    const group = this.group(owner, id);
    if (group.items.some((item) => item.status === 'unknown'))
      throw failure('仍有原生受理未确认的消息，请先核对并移除记录；不能自动重发。');
    if (group.items.some((item) => item.status === 'failed')) throw failure('请先编辑或移除失败的待发消息。');
    group.paused = false;
    group.reason = undefined;
    this.changed(group);
  }
  hasPending(agent: FollowupContext['agent'], sessionId?: string): boolean {
    return [...this.groups.values()].some(
      (group) =>
        group.context.agent === agent &&
        (!sessionId || group.context.sessionId === sessionId) &&
        group.items.some((item) => !terminal(item)),
    );
  }
  prune(): void {
    const now = this.now();
    for (const group of this.groups.values()) {
      const expired = group.items.filter((item) => item.expiresAt !== undefined && item.expiresAt <= now);
      for (const item of expired) this.receipts.get(group.owner)?.delete(item.clientMessageId);
      if (expired.length) {
        group.items = group.items.filter((item) => !expired.includes(item));
        this.changed(group);
      }
    }
  }
  discardOwner(owner: object): void {
    for (const group of this.groups.values()) if (group.owner === owner) this.groups.delete(group.context.queueId);
    this.receipts.delete(owner);
  }
}
