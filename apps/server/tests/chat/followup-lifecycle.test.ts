import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FollowupHost } from '../../src/chat/followup-host';
import { AttachmentStore } from '../../src/chat/attachments';
import { FollowupQuestions } from '../../src/chat/followup-questions';
import { codexAsyncQuestion } from '../../src/agents/codex/async-questions';

it('首轮创建会话同时绑定待发附件，编辑替换租约、过期版本拒绝且清空后释放文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-queue-lifecycle-'));
  const attachments = new AttachmentStore(root),
    owner = { send: vi.fn(), isOpen: () => true };
  const scope = { workspaceId: 'project', agent: 'codex' as const, conversationId: 'draft' };
  const host = new FollowupHost({
    attachments,
    send: owner.send,
    active: () => ({ blocked: false }),
    dispatch: async () => {},
    validateSteer: async () => {},
  });
  try {
    const queueId = host.register(
      owner,
      { type: 'chat.send', ...scope, text: 'first', clientTurnId: randomUUID() },
      'first',
    );
    const a = await attachments.upload(owner, scope, { name: 'a.txt', mimeType: '', data: Buffer.from('a') });
    const b = await attachments.upload(owner, scope, { name: 'b.txt', mimeType: '', data: Buffer.from('b') });
    const clientMessageId = randomUUID();
    const content = { text: 'queued', attachments: [{ id: a.id, revision: a.revision }] };
    await host.handle(owner, { type: 'chat.followup', queueId, clientMessageId, mode: 'queue', content });
    const previous = host.snapshots(owner)[0]!.items[0]!;
    await host.handle(owner, {
      type: 'followup.edit',
      queueId,
      clientMessageId,
      revision: previous.revision,
      content: { text: 'edited', attachments: [{ id: b.id, revision: b.revision }] },
    });
    await attachments.remove(owner, scope, a);
    await host.handle(owner, {
      type: 'followup.edit',
      queueId,
      clientMessageId,
      revision: previous.revision,
      content: { text: 'stale' },
    });
    expect(owner.send.mock.lastCall?.[1]).toMatchObject({ type: 'followup.error' });
    await host.bind('first', 'native');
    expect(host.snapshots(owner)[0]).toMatchObject({ sessionId: 'native', items: [{ content: { text: 'edited' } }] });
    await expect(attachments.remove(owner, { ...scope, sessionId: 'native' }, b)).rejects.toThrow();
    await host.handle(owner, { type: 'followup.clear', queueId });
    await attachments.remove(owner, { ...scope, sessionId: 'native' }, b);
  } finally {
    host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
it('同一原生会话的旧页面待发记录占用调度权，另一个已打开页面不能另建竞争队列', async () => {
  const owner = { send: vi.fn(), isOpen: () => true },
    other = { send: vi.fn(), isOpen: () => true };
  const host = new FollowupHost({
    send: owner.send,
    active: () => ({ blocked: false }),
    dispatch: async () => {},
    validateSteer: async () => {},
  });
  const message = {
    type: 'chat.send' as const,
    workspaceId: 'project',
    agent: 'codex' as const,
    sessionId: 'native',
    conversationId: 'draft',
    text: 'fixture',
    clientTurnId: randomUUID(),
  };
  try {
    const first = host.register(owner, message, 'first');
    host.finished('first', { success: true, attempted: true });
    const second = host.register(other, message, 'second');
    host.finished('second', { success: true, attempted: true });
    await host.handle(owner, {
      type: 'chat.followup',
      queueId: first,
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: 'queued' },
    });
    await host.handle(other, {
      type: 'chat.followup',
      queueId: second,
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: 'competing' },
    });
    expect(host.snapshots(other)[0]!.items).toEqual([]);
    expect(owner.send.mock.lastCall?.[1]).toMatchObject({ type: 'followup.error' });
  } finally {
    host.dispose();
  }
});

it('待答会话阻止派发，继续需要明确操作；引导拒绝改模型或技能，未取得session不启动', async () => {
  const owner = { send: vi.fn(), isOpen: () => true };
  let blocked = true;
  const dispatch = vi.fn(async () => {});
  const handle = {
    done: Promise.resolve(),
    interrupt: async () => {},
    canSteer: () => true,
    steer: vi.fn(async () => ({ status: 'accepted' as const })),
  };
  const host = new FollowupHost({
    send: owner.send,
    active: () => ({ handle, blocked }),
    blocked: () => blocked,
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
        conversationId: 'draft',
        text: 'first',
        model: 'fixture',
        clientTurnId: randomUUID(),
      },
      'first',
    );
    const message = {
      type: 'chat.followup' as const,
      queueId,
      clientMessageId: randomUUID(),
      turnId: 'first',
      mode: 'steer' as const,
      content: { text: 'guide', model: 'fixture' },
    };
    await host.handle(owner, message);
    expect(owner.send.mock.lastCall?.[1]).toMatchObject({ type: 'followup.error' });
    blocked = false;
    await host.handle(owner, { ...message, content: { text: 'guide', model: 'other' } });
    expect(handle.steer).not.toHaveBeenCalled();
    blocked = true;
    await host.handle(owner, { ...message, mode: 'queue' });
    expect(host.snapshots(owner)[0]!.paused).toBe(true);
    host.finished('first', { success: true, attempted: true });
    await host.handle(owner, { type: 'followup.resume', queueId });
    expect(dispatch).not.toHaveBeenCalled();
    blocked = false;
    await host.handle(owner, { type: 'followup.resume', queueId });
    expect(host.snapshots(owner)[0]!.items[0]).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('尚未创建'),
    });
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    host.dispose();
  }
});

it('异步问题有界且只替换已终结记录，不允许已排队答案被取消卡片伪装为撤销', () => {
  const questions = new FollowupQuestions();
  const base = codexAsyncQuestion(
    { type: 'agentMessage', id: 'question', delivery: 'async', questions: [{ title: '范围' }] },
    'native',
  )!;
  for (let i = 0; i < 32; i++) questions.observe({ ...base, messageId: String(i) });
  questions.observe({ ...base, messageId: 'overflow' });
  expect(questions.get('overflow')).toBeUndefined();
  const prepared = questions.prepare('0', { action: 'submit', values: { q0: 'fixture' } })!;
  questions.submitted('0', prepared.clientMessageId);
  expect(() => questions.prepare('0', { action: 'cancel' })).toThrow('待发');
  questions.snapshot([
    { clientMessageId: prepared.clientMessageId, revision: 1, text: '', mode: 'queue', status: 'accepted' },
  ]);
  questions.observe({ ...base, messageId: 'overflow' });
  expect(questions.get('overflow')).toBeDefined();
  expect(questions.get('0')).toBeUndefined();
  expect(() => questions.prepare('0', { action: 'cancel' })).toThrow('不可读取');
  questions.prepare('1', { action: 'cancel' });
  expect(questions.prepare('1', { action: 'submit', values: { q0: 'late' } })).toBeUndefined();
});
it('新队列快照触发恢复容量清理时，正在入队的附件租约也释放，不留下孤儿引用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-queue-discard-'));
  const attachments = new AttachmentStore(root),
    owner = { send: vi.fn(), isOpen: () => true };
  let drop = false;
  const host = new FollowupHost({
    attachments,
    send: () => {
      if (drop) host.discard(owner);
    },
    active: () => ({ blocked: false }),
    dispatch: async () => {},
    validateSteer: async () => {},
  });
  const scope = { workspaceId: 'project', agent: 'codex' as const, conversationId: 'draft' };
  try {
    const queueId = host.register(
      owner,
      { type: 'chat.send', ...scope, text: 'first', clientTurnId: randomUUID() },
      'first',
    );
    const file = await attachments.upload(owner, scope, {
      name: 'notes.txt',
      mimeType: '',
      data: Buffer.from('fixture'),
    });
    drop = true;
    await host.handle(owner, {
      type: 'chat.followup',
      queueId,
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: 'next', attachments: [{ id: file.id, revision: file.revision }] },
    });
    await attachments.remove(owner, scope, file);
  } finally {
    host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
