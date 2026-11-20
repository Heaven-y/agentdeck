import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { FollowupQueue } from '../../../src/chat/followups/followup-queue';

function setup() {
  let now = 1;
  const queue = new FollowupQueue({ now: () => now });
  const owner = {},
    other = {};
  const context = { queueId: randomUUID(), workspaceId: 'project', conversationId: 'draft', agent: 'codex' as const };
  queue.register(owner, context);
  return {
    queue,
    owner,
    other,
    context,
    tick: (ms: number) => {
      now += ms;
    },
  };
}
it('相同ID重连只返回既有受理结果，改内容或跨页面均拒绝，回执独立保留30分钟', () => {
  const f = setup(),
    id = randomUUID();
  const first = f.queue.add(f.owner, f.context.queueId, {
    clientMessageId: id,
    mode: 'queue',
    content: { text: 'first' },
  });
  const again = f.queue.add(f.owner, f.context.queueId, {
    clientMessageId: id,
    mode: 'queue',
    content: { text: 'first' },
  });
  expect(again).toEqual(first);
  expect(() =>
    f.queue.add(f.owner, f.context.queueId, { clientMessageId: id, mode: 'queue', content: { text: 'changed' } }),
  ).toThrow('内容');
  expect(() => f.queue.snapshot(f.other, f.context.queueId)).toThrow('页面');
  const claimed = f.queue.next(f.owner, f.context.queueId)!;
  expect(claimed.status).toBe('dispatching');
  f.queue.result(f.owner, f.context.queueId, id, { status: 'accepted' });
  f.tick(6 * 60_000);
  f.queue.prune();
  expect(
    f.queue.add(f.owner, f.context.queueId, { clientMessageId: id, mode: 'queue', content: { text: 'first' } }).status,
  ).toBe('accepted');
  f.tick(25 * 60_000);
  f.queue.prune();
  expect(f.queue.snapshot(f.owner, f.context.queueId).items).toEqual([]);
});
it('每会话最多十条，未知受理暂停且不能重试；编辑、删除需当前版本', () => {
  const f = setup();
  for (let i = 0; i < 10; i++)
    f.queue.add(f.owner, f.context.queueId, {
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: String(i) },
    });
  expect(() =>
    f.queue.add(f.owner, f.context.queueId, {
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: 'overflow' },
    }),
  ).toThrow('上限');
  const first = f.queue.snapshot(f.owner, f.context.queueId).items[0]!;
  f.queue.edit(f.owner, f.context.queueId, first.clientMessageId, {
    revision: first.revision,
    content: { text: 'edited' },
  });
  expect(() => f.queue.cancel(f.owner, f.context.queueId, first)).toThrow('版本');
  const claimed = f.queue.next(f.owner, f.context.queueId)!;
  f.queue.result(f.owner, f.context.queueId, claimed.clientMessageId, { status: 'unknown', reason: '原生受理未确认' });
  expect(f.queue.next(f.owner, f.context.queueId)).toBeUndefined();
  expect(() => f.queue.resume(f.owner, f.context.queueId)).toThrow('可能已发送');
  expect(() =>
    f.queue.edit(f.owner, f.context.queueId, claimed.clientMessageId, {
      revision: claimed.revision,
      content: { text: 'retry' },
    }),
  ).toThrow();
  const unknown = f.queue.snapshot(f.owner, f.context.queueId).items[0]!;
  f.queue.cancel(f.owner, f.context.queueId, unknown);
  f.queue.resume(f.owner, f.context.queueId);
  expect(f.queue.next(f.owner, f.context.queueId)?.content?.text).toBe('1');
});
it('宿主配额覆盖所有页面，失联暂停，清空不会把已投递项当成可撤销发送', () => {
  const f = setup();
  const groups = Array.from({ length: 10 }, (_, i) => ({
    ...f.context,
    queueId: randomUUID(),
    conversationId: String(i),
  }));
  for (const group of groups) {
    f.queue.register(f.owner, group);
    for (let i = 0; i < 10; i++)
      f.queue.add(f.owner, group.queueId, { clientMessageId: randomUUID(), mode: 'queue', content: { text: 'q' } });
  }
  expect(() =>
    f.queue.add(f.owner, f.context.queueId, {
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: 'overflow' },
    }),
  ).toThrow('上限');
  const group = groups[0]!;
  const sent = f.queue.next(f.owner, group.queueId)!;
  f.queue.pauseOwner(f.owner, '连接中断');
  f.queue.clear(f.owner, group.queueId);
  expect(
    f.queue.snapshot(f.owner, group.queueId).items.find((x) => x.clientMessageId === sent.clientMessageId)?.status,
  ).toBe('dispatching');
  expect(f.queue.next(f.owner, groups[1]!.queueId)).toBeUndefined();
  f.queue.discardOwner(f.owner);
  expect(() => f.queue.snapshot(f.owner, group.queueId)).toThrow();
});
it('队列仍有未决输入时旧受理回执不回收，全部确认后再计30分钟', () => {
  const f = setup(),
    first = randomUUID(),
    second = randomUUID();
  for (const id of [first, second])
    f.queue.add(f.owner, f.context.queueId, { clientMessageId: id, mode: 'queue', content: { text: id } });
  f.queue.next(f.owner, f.context.queueId);
  f.queue.result(f.owner, f.context.queueId, first, { status: 'accepted' });
  f.tick(31 * 60_000);
  f.queue.prune();
  expect(
    f.queue.add(f.owner, f.context.queueId, { clientMessageId: first, mode: 'queue', content: { text: first } }).status,
  ).toBe('accepted');
  f.queue.next(f.owner, f.context.queueId);
  f.queue.result(f.owner, f.context.queueId, second, { status: 'accepted' });
  f.tick(29 * 60_000);
  f.queue.prune();
  expect(f.queue.snapshot(f.owner, f.context.queueId).items).toHaveLength(2);
  f.tick(2 * 60_000);
  f.queue.prune();
  expect(f.queue.snapshot(f.owner, f.context.queueId).items).toEqual([]);
});
it('失败引导不能编辑成永远不会派发的排队项，必须核对后移除再显式发送', () => {
  const f = setup(),
    clientMessageId = randomUUID();
  f.queue.add(f.owner, f.context.queueId, { clientMessageId, mode: 'steer', content: { text: 'guide' } });
  f.queue.claimSteer(f.owner, f.context.queueId, clientMessageId);
  f.queue.result(f.owner, f.context.queueId, clientMessageId, { status: 'failed' });
  const item = f.queue.snapshot(f.owner, f.context.queueId).items[0]!;
  expect(() =>
    f.queue.edit(f.owner, f.context.queueId, clientMessageId, { revision: item.revision, content: { text: 'retry' } }),
  ).toThrow('引导');
});
