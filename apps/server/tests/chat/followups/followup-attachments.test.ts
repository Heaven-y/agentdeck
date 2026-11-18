import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AttachmentStore } from '../../../src/chat/attachments/attachments';

it('排队只持有元数据租约，未投递取消后仍可删除草稿，活动租约不会被过期回收', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-queued-attachments-'));
  let now = 1;
  const store = new AttachmentStore(root, { now: () => now });
  const owner = {},
    scope = { workspaceId: 'project', agent: 'codex' as const, conversationId: 'draft' };
  try {
    const asset = await store.upload(owner, scope, { name: 'notes.txt', mimeType: '', data: Buffer.from('fixture') });
    const hold = await store.hold(owner, scope, [asset]);
    expect(hold.assets[0]).not.toHaveProperty('data');
    expect(hold.assets[0]).not.toHaveProperty('path');
    await expect(store.remove(owner, scope, asset)).rejects.toThrow();
    now += 2 * 24 * 60 * 60_000;
    await store.collect();
    expect((await store.preview(owner, scope, asset)).data.toString()).toBe('fixture');
    await hold.bind('native');
    hold.release();
    hold.release();
    await store.remove(owner, { ...scope, sessionId: 'native' }, asset);
    await expect(store.preview(owner, { ...scope, sessionId: 'native' }, asset)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
