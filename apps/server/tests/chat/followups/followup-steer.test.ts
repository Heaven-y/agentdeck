import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FollowupHost } from '../../../src/chat/followups/followup-host';
import { AttachmentStore } from '../../../src/chat/attachments/attachments';
import type { ServerMessage } from '@agentdeck/shared/conversation';
import type { TurnHandle, NativeSteerInput } from '../../../src/agents/contracts';

it('引导附件先按实际通道校验，准备失败保留可撤销草稿，不交给原生', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-followup-steer-'));
  const store = new AttachmentStore(root),
    owner = { send: vi.fn<(message: ServerMessage) => void>(), isOpen: () => true };
  const native = vi.fn(async () => ({ status: 'accepted' as const }));
  const validate = vi.fn(async () => {
    throw new Error('不支持文件');
  });
  const host = new FollowupHost({
    attachments: store,
    send: (_owner, message) => owner.send(message),
    active: () => ({
      handle: { done: Promise.resolve(), interrupt: async () => {}, canSteer: () => true, steer: native },
      blocked: false,
    }),
    dispatch: async () => {},
    validateSteer: validate,
  });
  try {
    const scope = { workspaceId: 'project', agent: 'codex' as const, conversationId: 'draft', sessionId: 'native' };
    const queueId = host.register(
      owner,
      { type: 'chat.send', ...scope, text: 'first', clientTurnId: randomUUID() },
      'turn',
    );
    const file = await store.upload(owner, scope, { name: 'notes.txt', mimeType: '', data: Buffer.from('fixture') });
    const clientMessageId = randomUUID();
    await host.handle(owner, {
      type: 'chat.followup',
      queueId,
      clientMessageId,
      mode: 'steer',
      turnId: 'turn',
      content: { text: 'guide', attachments: [{ id: file.id, revision: file.revision }] },
    });
    expect(validate).toHaveBeenCalledOnce();
    expect(native).not.toHaveBeenCalled();
    const item = host.snapshots(owner)[0]!.items[0]!;
    expect(item.status).toBe('failed');
    await expect(store.remove(owner, scope, file)).rejects.toThrow();
    await host.handle(owner, { type: 'followup.cancel', queueId, clientMessageId, revision: item.revision });
    await store.remove(owner, scope, file);
  } finally {
    host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
it('原生迟到确认收敛未知且只发布一次完整引导，队列仍须显式继续', async () => {
  const owner = { send: vi.fn<(message: ServerMessage) => void>(), isOpen: () => true };
  let delivered!: NativeSteerInput;
  const native = vi.fn(async (input: NativeSteerInput) => {
    delivered = input;
    return { status: 'unknown' as const };
  });
  const dispatch = vi.fn(async () => {});
  const handle: TurnHandle = {
    done: Promise.resolve(),
    interrupt: async () => {},
    canSteer: () => true,
    steer: native,
  };
  const host = new FollowupHost({
    send: (_owner, message) => owner.send(message),
    active: () => ({ handle, blocked: false }),
    dispatch,
    validateSteer: async () => {},
  });
  try {
    const queueId = host.register(
      owner,
      {
        type: 'chat.send',
        workspaceId: 'project',
        agent: 'codex',
        text: 'first',
        sessionId: 'native',
        clientTurnId: randomUUID(),
      },
      'turn',
    );
    const text = '完整引导'.repeat(100);
    await host.handle(owner, {
      type: 'chat.followup',
      queueId,
      clientMessageId: randomUUID(),
      mode: 'steer',
      turnId: 'turn',
      content: { text },
    });
    await host.handle(owner, {
      type: 'chat.followup',
      queueId,
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: 'next' },
    });
    host.finished('turn', { success: true, attempted: true });
    expect(dispatch).not.toHaveBeenCalled();
    delivered.onAccepted!();
    delivered.onAccepted!();
    const events = owner.send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'followup.delivered');
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe(text);
    expect(host.snapshots(owner)[0]).toMatchObject({
      paused: true,
      items: [{ status: 'accepted' }, { status: 'queued' }],
    });
    await host.handle(owner, { type: 'followup.resume', queueId });
    expect(dispatch).toHaveBeenCalledOnce();
  } finally {
    host.dispose();
  }
});

it('引导图片校验期间结束原生轮次时不得投递，新会话无误绑定；正常确认重复回调不重复显示', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-followup-race-'));
  const store = new AttachmentStore(root),
    owner = { send: vi.fn<(message: ServerMessage) => void>(), isOpen: () => true };
  let release!: () => void;
  const validation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const validate = vi.fn(() => validation);
  const native = vi.fn(async (input: NativeSteerInput) => {
    input.onAccepted?.();
    input.onAccepted?.();
    return { status: 'accepted' as const };
  });
  const handle: TurnHandle = {
    done: Promise.resolve(),
    interrupt: async () => {},
    canSteer: () => true,
    steer: native,
  };
  const host = new FollowupHost({
    attachments: store,
    send: (_owner, message) => owner.send(message),
    active: () => ({ handle, blocked: false }),
    dispatch: async () => {},
    validateSteer: validate,
  });
  const scope = { workspaceId: 'project', agent: 'codex' as const, conversationId: 'draft', sessionId: 'native' };
  try {
    const queueId = host.register(
      owner,
      { type: 'chat.send', ...scope, text: 'first', clientTurnId: randomUUID() },
      'turn',
    );
    const asset = await store.upload(owner, scope, { name: 'notes.txt', mimeType: '', data: Buffer.from('fixture') });
    const action = {
      type: 'chat.followup' as const,
      queueId,
      clientMessageId: randomUUID(),
      mode: 'steer' as const,
      turnId: 'turn',
      content: { text: 'guide', attachments: [{ id: asset.id, revision: asset.revision }] },
    };
    const pending = host.handle(owner, action);
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
    host.finished('turn', { success: true, attempted: true });
    release();
    await pending;
    expect(native).not.toHaveBeenCalled();
    expect(host.snapshots(owner)[0]!.items[0]!.status).toBe('failed');
    await host.handle(owner, { type: 'followup.clear', queueId });
    host.register(owner, { type: 'chat.send', ...scope, text: 'again', clientTurnId: randomUUID() }, 'second');
    await host.handle(owner, { ...action, turnId: 'second', clientMessageId: randomUUID() });
    expect(native).toHaveBeenCalledOnce();
    const events = owner.send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'followup.delivered');
    expect(events).toHaveLength(1);
    expect(events[0]!.attachments).toMatchObject([{ name: 'notes.txt' }]);
    host.finished('second', { success: true, attempted: true });
    expect(host.snapshots(owner)[0]!.items.at(-1)!.status).toBe('accepted');
  } finally {
    release();
    host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('原生投递抛错属于受理未知，不能伪报可重试失败；实例结束前后都不重复投递', async () => {
  const owner = { send: vi.fn<(message: ServerMessage) => void>(), isOpen: () => true };
  const native = vi.fn(async () => {
    throw new Error('transport lost');
  });
  const handle: TurnHandle = {
    done: Promise.resolve(),
    interrupt: async () => {},
    canSteer: () => true,
    steer: native,
  };
  const host = new FollowupHost({
    send: (_owner, message) => owner.send(message),
    active: () => ({ handle, blocked: false }),
    dispatch: vi.fn(),
    validateSteer: async () => {},
  });
  const queueId = host.register(
    owner,
    {
      type: 'chat.send',
      workspaceId: 'project',
      agent: 'codex',
      text: 'first',
      sessionId: 'native',
      clientTurnId: randomUUID(),
    },
    'turn',
  );
  const message = {
    type: 'chat.followup' as const,
    queueId,
    clientMessageId: randomUUID(),
    mode: 'steer' as const,
    turnId: 'turn',
    content: { text: 'guide' },
  };
  try {
    await host.handle(owner, message);
    expect(host.snapshots(owner)[0]).toMatchObject({ paused: true, items: [{ status: 'unknown' }] });
    host.finished('turn', { success: true, attempted: true });
    await host.handle(owner, message);
    await host.handle(owner, { type: 'followup.resume', queueId });
    expect(native).toHaveBeenCalledOnce();
    expect(host.snapshots(owner)[0]!.paused).toBe(true);
  } finally {
    host.dispose();
  }
});
