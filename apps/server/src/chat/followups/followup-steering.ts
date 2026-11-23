import type { ChatAttachment, FollowupItem } from '@agentdeck/shared/conversation';
import type { NativeInputResult, TurnHandle } from '../../agents/contracts';
import { SessionError } from '../../agents/errors';
import type { AttachmentLease } from '../attachments/attachments';
import type { FollowupGroup, FollowupHostDeps } from './followup-host';
import type { FollowupQueue } from './followup-queue';

type Delivery = {
  group: FollowupGroup;
  item: FollowupItem;
  turnId: string;
  handle: TurnHandle;
  attempted: boolean;
  assets?: AttachmentLease;
};
export class FollowupSteering {
  constructor(
    private readonly deps: FollowupHostDeps,
    private readonly queue: FollowupQueue,
    private readonly exists: (group: FollowupGroup) => boolean,
  ) {}
  async run(group: FollowupGroup, item: FollowupItem): Promise<void> {
    const turnId = group.turnId;
    const handle = turnId ? this.deps.active(turnId)?.handle : undefined;
    if (!turnId || !handle?.canSteer?.() || !handle.steer) {
      this.result(group, item, { status: 'rejected', message: '本轮已结束，输入仍保留在待发记录。' });
      return;
    }
    this.queue.claimSteer(group.owner, group.context.queueId, item.clientMessageId);
    const delivery: Delivery = { group, item, turnId, handle, attempted: false };
    try {
      delivery.assets = await this.prepare(delivery);
      this.assertActive(delivery);
      await this.dispatch(delivery);
    } catch (error) {
      this.result(group, item, {
        status: delivery.attempted ? 'unknown' : 'rejected',
        message: failureMessage(error, delivery.attempted),
      });
    } finally {
      this.release(delivery);
    }
  }
  private async prepare({ group, item, turnId }: Delivery): Promise<AttachmentLease | undefined> {
    if (!item.content?.attachments?.length) return;
    const store = this.deps.attachments!;
    const assets = await store.inspect(group.owner, group.context, item.content.attachments);
    await this.deps.validateSteer(turnId, assets);
    return store.acquire(group.owner, group.context, item.content.attachments);
  }
  private assertActive({ group, turnId, handle }: Delivery): void {
    const active = this.deps.active(turnId);
    if (
      !this.exists(group) ||
      group.turnId !== turnId ||
      active?.handle !== handle ||
      active.blocked ||
      !handle.canSteer?.()
    )
      throw new SessionError(409, 'followup_conflict', '本轮已结束或正在等待答复，输入已保留。');
  }
  private async dispatch(delivery: Delivery): Promise<void> {
    const { group, item, handle, turnId, assets } = delivery;
    const attachments = group.leases.get(item.clientMessageId)?.assets;
    const text = this.deps.prepareSteerText
      ? await this.deps.prepareSteerText(turnId, item.content!.text)
      : item.content!.text;
    this.assertActive(delivery);
    if (assets) group.runningAssets.push(assets);
    delivery.attempted = true;
    const result = await handle.steer!({
      clientMessageId: item.clientMessageId,
      text,
      attachments: assets?.files,
      onAccepted: () => this.accept(group, item, turnId, attachments),
      attachmentsStored: assets ? (ids) => assets.stored(ids) : undefined,
    });
    if (result.status === 'accepted') this.accept(group, item, turnId, attachments);
    else this.result(group, item, result);
    if (result.status === 'rejected' && assets) releaseRunning(group, assets);
  }
  private result(group: FollowupGroup, item: FollowupItem, result: NativeInputResult): void {
    if (this.exists(group))
      this.queue.result(group.owner, group.context.queueId, item.clientMessageId, {
        status: result.status === 'rejected' ? 'failed' : result.status,
        reason: result.message,
      });
  }
  private accept(group: FollowupGroup, item: FollowupItem, turnId: string, attachments?: ChatAttachment[]): void {
    if (!this.exists(group)) return;
    const current = this.queue
      .snapshot(group.owner, group.context.queueId)
      .items.find((value) => value.clientMessageId === item.clientMessageId);
    if (!current || ['accepted', 'cancelled'].includes(current.status)) return;
    this.deps.send(group.owner, {
      type: 'followup.delivered',
      ...group.context,
      turnId,
      clientMessageId: item.clientMessageId,
      text: item.content!.text,
      attachments,
    });
    this.result(group, item, { status: 'accepted' });
  }
  private release({ group, item, attempted, assets, turnId }: Delivery): void {
    if (attempted) {
      group.leases.get(item.clientMessageId)?.release();
      group.leases.delete(item.clientMessageId);
    }
    if (assets && (!attempted || group.turnId !== turnId)) releaseRunning(group, assets);
  }
}
function releaseRunning(group: FollowupGroup, lease: AttachmentLease): void {
  lease.release();
  group.runningAssets = group.runningAssets.filter((value) => value !== lease);
}
function failureMessage(error: unknown, attempted: boolean): string {
  if (attempted) return '这条消息可能已发送，请先重新读取会话。';
  return error instanceof SessionError ? error.message : '引导准备失败，输入已保留。';
}
