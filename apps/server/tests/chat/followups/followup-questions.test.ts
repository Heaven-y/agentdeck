import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { AgentEvent, ClientMessage, ServerMessage } from '@agentdeck/shared/conversation';
import type { AgentTurnInput } from '../../../src/agents/contracts';
import { TurnManager } from '../../../src/chat/turn-manager';
import { codexAsyncQuestion, asyncAnswerMarker } from '../../../src/agents/codex/interaction/async-questions';

const question = codexAsyncQuestion(
  {
    type: 'agentMessage',
    id: 'question',
    delivery: 'async',
    questions: [{ title: '范围', options: ['本模块', '全部'] }],
  },
  'native',
)!;
function fixture() {
  const sent: ServerMessage[] = [],
    runs: Array<{ input: AgentTurnInput; finish(): void }> = [];
  const history: AgentEvent[] = [{ type: 'async_question', question }];
  const read = vi.fn(async () => ({
    session: { agent: 'codex' as const, sessionId: 'native', summary: 'fixture', lastModified: 0 },
    events: history,
  }));
  const owner = { send: (message: ServerMessage) => sent.push(message), isOpen: () => true };
  const manager = new TurnManager({
    getWorkspace: async (id) => ({ id, name: 'fixture', dir: process.cwd() }),
    sessions: { assertBelongs: async () => {}, read },
    runners: {
      codex: (input) => {
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        runs.push({
          input,
          finish: () => {
            input.emit({ type: 'turn_end', isError: false });
            finish();
          },
        });
        input.onInputAccepted?.();
        return { done, interrupt: async () => finish() };
      },
    },
  });
  const response: Extract<ClientMessage, { type: 'question.respond' }> = {
    type: 'question.respond',
    workspaceId: 'project',
    agent: 'codex',
    conversationId: 'draft',
    sessionId: 'native',
    messageId: 'question',
    answer: { action: 'submit', values: { q0: '本模块' } },
  };
  return { manager, owner, sent, runs, read, history, response };
}

it('同一原生问题只排一条答复，重复或修改答复不重复派发，后台归属不由当前页面选择决定', async () => {
  const f = fixture();
  try {
    await f.manager.handle(f.owner, {
      type: 'chat.send',
      workspaceId: 'project',
      agent: 'codex',
      conversationId: 'draft',
      sessionId: 'native',
      clientTurnId: randomUUID(),
      text: 'first',
    });
    f.runs[0]!.input.emit({ type: 'async_question', question });
    await f.manager.handle(f.owner, f.response);
    await f.manager.handle(f.owner, f.response);
    await f.manager.handle(f.owner, { ...f.response, answer: { action: 'submit', values: { q0: '全部' } } });
    expect(f.sent.at(-1)?.type).toBe('question.error');
    expect(f.manager.followups.snapshots(f.owner)[0]).toMatchObject({
      items: [{ status: 'queued' }],
      questions: [{ status: 'queued' }],
    });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.runs).toHaveLength(1);
    f.runs[0]!.finish();
    await vi.waitFor(() => expect(f.runs).toHaveLength(2));
    expect(f.runs[1]!.input).toMatchObject({
      sessionId: 'native',
      text: `${asyncAnswerMarker(question)}\n范围：本模块`,
    });
    await f.manager.handle(f.owner, f.response);
    expect(f.runs).toHaveLength(2);
    expect(f.manager.followups.snapshots(f.owner)[0]!.questions?.[0]!.status).toBe('accepted');
    f.runs[1]!.finish();
  } finally {
    await f.manager.dispose();
  }
});

it('已结束会话的答复从原生历史核对，跨会话/不存在的问题拒绝；原生已答不会再发', async () => {
  const f = fixture();
  try {
    await f.manager.handle(f.owner, { ...f.response, sessionId: 'other' });
    expect(f.sent.at(-1)?.type).toBe('question.error');
    expect(f.runs).toHaveLength(0);
    await f.manager.handle(f.owner, { ...f.response, messageId: 'missing' });
    expect(f.sent.at(-1)?.type).toBe('question.error');
    expect(f.runs).toHaveLength(0);
    f.history[0] = { type: 'async_question', question, answered: true };
    await f.manager.handle(f.owner, f.response);
    expect(f.runs).toHaveLength(0);
    expect(f.manager.followups.snapshots(f.owner)[0]!.questions?.[0]!.status).toBe('accepted');
  } finally {
    await f.manager.dispose();
  }
});

it('读取历史中的未答问题后可以安全续聊，取消问题只关闭卡片，不向模型伪造答案', async () => {
  const f = fixture();
  try {
    await f.manager.handle(f.owner, f.response);
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]!.input.sessionId).toBe('native');
    const other = { ...question, messageId: 'second' };
    f.runs[0]!.input.emit({ type: 'async_question', question: other });
    await f.manager.handle(f.owner, { ...f.response, messageId: 'second', answer: { action: 'cancel' } });
    expect(f.manager.followups.snapshots(f.owner)[0]!.questions?.[1]!.status).toBe('cancelled');
    f.runs[0]!.finish();
  } finally {
    await f.manager.dispose();
  }
});
it('原轮结束后的旧卡片必须重读原生，另一页面已回答时只收敛状态不再派发', async () => {
  const f = fixture();
  const other = { send: vi.fn(), isOpen: () => true };
  try {
    await f.manager.handle(f.owner, {
      type: 'chat.send',
      workspaceId: 'project',
      agent: 'codex',
      conversationId: 'draft',
      sessionId: 'native',
      clientTurnId: randomUUID(),
      text: 'first',
    });
    f.runs[0]!.input.emit({ type: 'async_question', question });
    f.runs[0]!.finish();
    await vi.waitFor(() => expect(f.manager.followups.snapshots(f.owner)[0]?.activeTurnId).toBeUndefined());
    await f.manager.handle(other, { ...f.response, conversationId: 'other-view' });
    f.runs[1]!.finish();
    await vi.waitFor(() => expect(f.manager.followups.snapshots(other)[0]?.activeTurnId).toBeUndefined());
    f.history[0] = { type: 'async_question', question, answered: true };
    f.read.mockClear();
    await f.manager.handle(f.owner, f.response);
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.runs).toHaveLength(2);
    expect(f.manager.followups.snapshots(f.owner)[0]?.questions?.[0]?.status).toBe('accepted');
  } finally {
    await f.manager.dispose();
  }
});
it('两个owner并发核题即使原生历史尚未显示已答，也只能投递一次；owner失效仍不得重发未知受理', async () => {
  const f = fixture();
  const other = { send: vi.fn(), isOpen: () => true };
  try {
    await Promise.all([
      f.manager.handle(f.owner, f.response),
      f.manager.handle(other, { ...f.response, conversationId: 'other-view' }),
    ]);
    expect(f.runs).toHaveLength(1);
    f.runs[0]!.finish();
    await vi.waitFor(() => expect(f.manager.followups.snapshots(f.owner)[0]?.activeTurnId).toBeUndefined());
    f.manager.socketClosed(f.owner);
    await f.manager.handle(other, { ...f.response, conversationId: 'other-view' });
    expect(f.runs).toHaveLength(1);
  } finally {
    await f.manager.dispose();
  }
});
it('历史核题期间离线，迟到新列表保持暂停；重连不会自动执行且须显式继续', async () => {
  const f = fixture();
  let resolve!: (value: Awaited<ReturnType<typeof f.read>>) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  try {
    const answering = f.manager.handle(f.owner, f.response);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    f.manager.socketOffline(f.owner);
    resolve({
      session: { agent: 'codex', sessionId: 'native', summary: 'fixture', lastModified: 0 },
      events: f.history,
    });
    await answering;
    expect(f.runs).toHaveLength(0);
    const state = f.manager.followups.snapshots(f.owner)[0]!;
    expect(state).toMatchObject({ paused: true, items: [{ status: 'queued' }] });
    await f.manager.handle(f.owner, { type: 'followup.resume', queueId: state.queueId });
    expect(f.runs).toHaveLength(1);
  } finally {
    await f.manager.dispose();
  }
});
it('先阻塞后回答异步题保持列表暂停，解除阻塞和父轮成功都不隐式继续', async () => {
  const f = fixture();
  try {
    await f.manager.handle(f.owner, {
      type: 'chat.send',
      workspaceId: 'project',
      agent: 'codex',
      conversationId: 'draft',
      sessionId: 'native',
      clientTurnId: randomUUID(),
      text: 'first',
    });
    f.runs[0]!.input.emit({ type: 'async_question', question });
    const pending = f.runs[0]!.input.requestInteraction!({
      runtimeId: 'runtime',
      spec: {
        kind: 'questions',
        blocking: true,
        title: '阻塞',
        fields: [{ id: 'q', type: 'text', label: '说明', required: true }],
      },
    });
    await f.manager.handle(f.owner, f.response);
    const state = f.manager.followups.snapshots(f.owner)[0]!;
    expect(state.paused).toBe(true);
    const interaction = f.sent.find((m) => m.type === 'agent.event' && m.event.type === 'interaction_request');
    if (interaction?.type !== 'agent.event' || interaction.event.type !== 'interaction_request')
      throw new Error('缺少阻塞卡片');
    await f.manager.handle(f.owner, {
      type: 'interaction.respond',
      id: interaction.event.interaction.id,
      answer: { action: 'submit', values: { q: '完成' } },
    });
    await pending;
    f.runs[0]!.finish();
    await vi.waitFor(() => expect(f.manager.followups.snapshots(f.owner)[0]?.activeTurnId).toBeUndefined());
    expect(f.runs).toHaveLength(1);
    await f.manager.handle(f.owner, { type: 'followup.resume', queueId: state.queueId });
    expect(f.runs).toHaveLength(2);
  } finally {
    await f.manager.dispose();
  }
});
