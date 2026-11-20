import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { AgentTurnInput } from '../../../src/agents/contracts';
import { TurnManager, type Socket } from '../../../src/chat/turn-manager';
import type { ServerMessage } from '@agentdeck/shared/conversation';
import { createWorkspaceActivity } from '../../../src/workspaces/activity';

function fixture(agent: 'codex' | 'antigravity' = 'codex') {
  const sent: ServerMessage[] = [],
    inputs: Array<{ input: AgentTurnInput; finish(error?: boolean | 'unconfirmed'): void; close(): void }> = [];
  const socket: Socket = { send: (message) => sent.push(message), isOpen: () => true };
  const activity = createWorkspaceActivity();
  const manager = new TurnManager({
    getWorkspace: async (id) => ({ id, name: 'fixture', dir: process.cwd() }),
    sessions: { assertBelongs: async () => {} },
    acquireWorkspace: (id) => activity.acquire(id),
    runners: {
      [agent]: (input: AgentTurnInput) => {
        let resolve!: () => void;
        const done = new Promise<void>((r) => {
          resolve = r;
        });
        inputs.push({
          input,
          finish(error = false) {
            input.emit({
              type: 'turn_end',
              isError: !!error,
              ...(error === 'unconfirmed' ? { outcome: 'unconfirmed' } : {}),
            });
            resolve();
          },
          close: resolve,
        });
        input.onInputAccepted?.();
        return {
          done,
          interrupt: async () => {
            inputs.find((entry) => entry.input === input)!.finish(true);
          },
        };
      },
    },
  });
  return { sent, inputs, socket, manager, activity };
}
it('首次无session的两条队列只在原生成功结束后顺序续接，重复追加不重复投递', async () => {
  const f = fixture();
  try {
    await f.manager.handle(f.socket, {
      type: 'chat.send',
      workspaceId: 'project',
      agent: 'codex',
      conversationId: 'draft',
      text: 'first',
      clientTurnId: randomUUID(),
    });
    const started = f.sent.find((message) => message.type === 'turn.started');
    expect(started?.queueId).toBeTypeOf('string');
    const queueId = started!.queueId!;
    const next = {
      type: 'chat.followup' as const,
      queueId,
      clientMessageId: randomUUID(),
      mode: 'queue' as const,
      content: { text: 'second' },
    };
    await f.manager.handle(f.socket, next);
    await f.manager.handle(f.socket, next);
    await f.manager.handle(f.socket, { ...next, clientMessageId: randomUUID(), content: { text: 'third' } });
    expect(f.inputs).toHaveLength(1);
    f.inputs[0]!.input.emit({ type: 'session', sessionId: 'native', cwd: process.cwd(), model: 'fixture' });
    f.inputs[0]!.finish();
    await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
    expect(f.inputs[1]!.input).toMatchObject({ text: 'second', sessionId: 'native' });
    f.inputs[1]!.finish();
    await vi.waitFor(() => expect(f.inputs).toHaveLength(3));
    expect(f.inputs[2]!.input.text).toBe('third');
    f.inputs[2]!.finish();
  } finally {
    await f.manager.dispose();
  }
});

it('运行句柄静默关闭不代表原生成功，不能触发下一条排队消息', async () => {
  const f = fixture();
  try {
    await f.manager.handle(f.socket, {
      type: 'chat.send',
      workspaceId: 'project',
      agent: 'codex',
      sessionId: 'native',
      text: 'first',
      clientTurnId: randomUUID(),
    });
    const queueId = f.sent.find((message) => message.type === 'turn.started')!.queueId!;
    await f.manager.handle(f.socket, {
      type: 'chat.followup',
      queueId,
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: 'second' },
    });
    f.inputs[0]!.close();
    await vi.waitFor(() => expect(f.sent.some((message) => message.type === 'turn.finished')).toBe(true));
    expect(f.inputs).toHaveLength(1);
    expect(f.manager.followups.snapshots(f.socket)[0]).toMatchObject({ paused: true, items: [{ status: 'queued' }] });
  } finally {
    await f.manager.dispose();
  }
});
it('原生结果未确认时保持待发消息并给出中性暂停原因', async () => {
  const f = fixture('antigravity');
  try {
    await f.manager.handle(f.socket, {
      type: 'chat.send',
      workspaceId: 'project',
      agent: 'antigravity',
      sessionId: 'native',
      text: 'first',
      clientTurnId: randomUUID(),
    });
    const queueId = f.sent.find((message) => message.type === 'turn.started')!.queueId!;
    await f.manager.handle(f.socket, {
      type: 'chat.followup',
      queueId,
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: 'second' },
    });
    f.inputs[0]!.finish('unconfirmed');
    await vi.waitFor(() => expect(f.sent.some((message) => message.type === 'turn.finished')).toBe(true));
    expect(f.inputs).toHaveLength(1);
    expect(f.manager.followups.snapshots(f.socket)[0]).toMatchObject({
      paused: true,
      reason: '本轮结果尚未确认，待发已暂停。',
      items: [{ status: 'queued' }],
    });
    await f.manager.handle(f.socket, { type: 'followup.resume', queueId });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
    f.inputs[1]!.finish();
  } finally {
    await f.manager.dispose();
  }
});
it('失败与离线暂停队列，活动或待发会话都阻止维护，跨页面追加拒绝', async () => {
  const f = fixture();
  try {
    await f.manager.handle(f.socket, {
      type: 'chat.send',
      workspaceId: 'project',
      agent: 'codex',
      conversationId: 'draft',
      sessionId: 'native',
      text: 'first',
      clientTurnId: randomUUID(),
    });
    const started = f.sent.find((message) => message.type === 'turn.started');
    expect(started?.queueId).toBeTypeOf('string');
    const queueId = started!.queueId!,
      item = {
        type: 'chat.followup' as const,
        queueId,
        clientMessageId: randomUUID(),
        mode: 'queue' as const,
        content: { text: 'second' },
      };
    const foreign: ServerMessage[] = [];
    await f.manager.handle({ send: (message) => foreign.push(message), isOpen: () => true }, item);
    expect(foreign.at(-1)?.type).toBe('followup.error');
    await f.manager.handle(f.socket, item);
    f.inputs[0]!.finish(true);
    await vi.waitFor(() => expect(f.sent.some((message) => message.type === 'turn.finished')).toBe(true));
    expect(f.inputs).toHaveLength(1);
    await expect(f.manager.withIdleAgent('codex', async () => {})).rejects.toThrow();
    await expect(f.activity.withIdle('project', async () => {})).rejects.toThrow();
    await f.manager.handle(f.socket, { type: 'followup.resume', queueId });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
    await f.manager.handle(f.socket, { ...item, clientMessageId: randomUUID(), content: { text: 'third' } });
    f.manager.socketOffline(f.socket);
    f.inputs[1]!.finish();
    await vi.waitFor(() => expect(f.sent.filter((message) => message.type === 'turn.finished')).toHaveLength(2));
    expect(f.inputs).toHaveLength(2);
  } finally {
    await f.manager.dispose();
  }
});
it('连接断开时尚无队列也暂停随后迟到的追加，重连本身不恢复执行', async () => {
  const f = fixture();
  try {
    await f.manager.handle(f.socket, {
      type: 'chat.send',
      workspaceId: 'project',
      agent: 'codex',
      sessionId: 'native',
      text: 'first',
      clientTurnId: randomUUID(),
    });
    const queueId = f.sent.find((message) => message.type === 'turn.started')!.queueId!;
    f.manager.socketOffline(f.socket);
    await f.manager.handle(f.socket, {
      type: 'chat.followup',
      queueId,
      clientMessageId: randomUUID(),
      mode: 'queue',
      content: { text: 'late' },
    });
    f.inputs[0]!.finish();
    await vi.waitFor(() => expect(f.sent.some((message) => message.type === 'turn.finished')).toBe(true));
    expect(f.inputs).toHaveLength(1);
    expect(f.manager.followups.snapshots(f.socket)[0]!.paused).toBe(true);
  } finally {
    await f.manager.dispose();
  }
});
