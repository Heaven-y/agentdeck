import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ContextUsage, ServerMessage, SessionHistory } from '@agentdeck/shared/conversation';
import { sessionsApi } from '../../../../src/features/sessions/api';
import { startChatConnection, useChat } from '../../../../src/features/chat/state/chat-store';

let receive: (message: ServerMessage) => void;
const sent: ClientMessage[] = [];
beforeAll(() => {
  startChatConnection((handlers) => {
    receive = handlers.onMessage;
    return { send: (message) => (sent.push(message), true), reconnect() {}, close() {} };
  });
});
beforeEach(() => {
  sent.length = 0;
  useChat.setState(useChat.getInitialState(), true);
  useChat.setState({ workspaceId: 'project', connection: 'open', agent: 'antigravity' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const usage: ContextUsage = { source: 'antigravity_estimate', usedTokens: 1200, windowTokens: 256000 };
function history(context = usage): SessionHistory {
  return {
    session: { agent: 'antigravity', sessionId: 'native', summary: '历史标题', lastModified: 1 },
    actualModel: '历史模型',
    events: [
      { type: 'text', delta: '不应覆盖实时正文' },
      { type: 'compaction', state: { status: 'completed' } },
      { type: 'context', usage: context },
    ],
  };
}
function pending() {
  let resolve!: (value: SessionHistory) => void;
  const promise = new Promise<SessionHistory>((done) => (resolve = done));
  return { promise, resolve };
}
function start(turnId = 'turn-one', replyId?: string) {
  expect(useChat.getState().send('示例输入')).toBe(true);
  const message = sent.at(-1) as Extract<ClientMessage, { type: 'chat.send' }>;
  receive({
    type: 'turn.started',
    turnId,
    clientTurnId: message.clientTurnId,
    workspaceId: 'project',
    agent: 'antigravity',
  });
  receive({
    type: 'agent.event',
    turnId,
    event: { type: 'session', agent: 'antigravity', sessionId: 'native', cwd: 'project', model: '当前模型' },
  });
  receive({
    type: 'agent.event',
    turnId,
    event: { type: 'text', delta: '实时正文', ...(replyId ? { id: replyId } : {}) },
  });
}
function finish(turnId = 'turn-one') {
  receive({ type: 'agent.event', turnId, event: { type: 'turn_end', isError: false } });
  receive({ type: 'turn.finished', turnId, workspaceId: 'project', agent: 'antigravity' });
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

it('AGY 缺少实时用量的回合结束后只读补齐上下文，不替换正文、模型或压缩状态', async () => {
  const read = vi.spyOn(sessionsApi, 'sessionEvents').mockResolvedValue(history());
  start();
  finish();
  const items = useChat.getState().items;
  await settle();
  expect(useChat.getState().contextUsage).toEqual(usage);
  expect(useChat.getState().items).toBe(items);
  expect(useChat.getState().actualModel).toBe('当前模型');
  expect(useChat.getState().compaction).toBeUndefined();
  expect(read).toHaveBeenCalledExactlyOnceWith('project', 'native', 'antigravity', expect.any(AbortSignal));
  expect(sent.filter((message) => message.type === 'chat.send')).toHaveLength(1);
});

it('本轮已有实时上下文时保留实时报告，下一轮缺少用量仍会刷新', async () => {
  const live = { ...usage, usedTokens: 1600 };
  const lastRequest = { inputTokens: 1000, cachedInputTokens: 2000, inputBudgetTokens: 256000 };
  const read = vi
    .spyOn(sessionsApi, 'sessionEvents')
    .mockResolvedValueOnce(history({ ...usage, lastRequest }))
    .mockResolvedValue(history());
  start();
  receive({ type: 'agent.event', turnId: 'turn-one', event: { type: 'context', usage: live } });
  finish();
  await settle();
  expect(useChat.getState().contextUsage).toEqual({ ...live, lastRequest });
  expect(read).toHaveBeenCalledOnce();
  start('turn-two');
  finish('turn-two');
  await settle();
  expect(useChat.getState().contextUsage).toEqual(usage);
});

it('后台会话完成后的上下文归原会话，当前视图不受影响', async () => {
  const result = pending();
  vi.spyOn(sessionsApi, 'sessionEvents').mockReturnValue(result.promise);
  start();
  const first = useChat.getState().conversationId;
  useChat.getState().newSession('codex');
  finish();
  result.resolve(history());
  await settle();
  expect(useChat.getState().contextUsage).toBeUndefined();
  expect(useChat.getState().background[first]?.contextUsage).toEqual(usage);
  expect(JSON.stringify(useChat.getState().background[first]?.items)).toContain('实时正文');
});

it('同一会话新轮完成后迟到的旧轮上下文不能倒灌，即使两轮在同一时刻发送', async () => {
  vi.useFakeTimers();
  const first = pending();
  const second = pending();
  const read = vi
    .spyOn(sessionsApi, 'sessionEvents')
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  start();
  finish();
  await settle();
  const firstSignal = read.mock.calls[0]?.[3];
  start('turn-two');
  finish('turn-two');
  second.resolve(history({ ...usage, usedTokens: 2400 }));
  await settle();
  first.resolve(history());
  await settle();
  expect(firstSignal?.aborted).toBe(true);
  expect(useChat.getState().contextUsage?.usedTokens).toBe(2400);
});

it.each(['session', 'agent', 'missing', 'failure'] as const)(
  '补读遇到%s异常保留已有用量和实时正文',
  async (scenario) => {
    const result = history();
    if (scenario === 'session') result.session.sessionId = 'other';
    if (scenario === 'agent') result.session.agent = 'codex';
    if (scenario === 'missing') result.events = [];
    const read = vi.spyOn(sessionsApi, 'sessionEvents');
    if (scenario === 'failure') read.mockRejectedValue(new Error('原生历史不可用'));
    else read.mockResolvedValue(result);
    useChat.setState({ contextUsage: { ...usage, usedTokens: 100, lastRequest: { inputTokens: 50 } } });
    start();
    finish();
    const items = useChat.getState().items;
    await settle();
    expect(useChat.getState().contextUsage?.usedTokens).toBe(100);
    if (scenario === 'missing') expect(useChat.getState().contextUsage?.lastRequest).toBeUndefined();
    expect(useChat.getState().items).toBe(items);
    expect(useChat.getState().banner).toBeUndefined();
    expect(useChat.getState().historyError).toBeUndefined();
  },
);

it('补读超过预算时取消，迟到结果不能写入；下一轮仍可正常刷新', async () => {
  vi.useFakeTimers();
  const result = pending();
  const read = vi.spyOn(sessionsApi, 'sessionEvents').mockReturnValueOnce(result.promise).mockResolvedValue(history());
  start();
  finish();
  await settle();
  const signal = read.mock.calls[0]?.[3];
  await vi.advanceTimersByTimeAsync(5000);
  expect(signal?.aborted).toBe(true);
  result.resolve(history({ ...usage, usedTokens: 9999 }));
  await settle();
  expect(useChat.getState().contextUsage).toBeUndefined();
  start('turn-two');
  finish('turn-two');
  await settle();
  expect(useChat.getState().contextUsage).toEqual(usage);
});

it('已有实时上下文仍补齐本轮同一步骤的响应模型，不改正文、历史回复或菜单型号', async () => {
  const result = history();
  result.events = [
    { type: 'user_message', text: '前一轮' },
    { type: 'text', id: 'agy-step-1', delta: '旧回复', responseModel: 'old-model' },
    { type: 'user_message', text: '示例输入' },
    { type: 'text', id: 'agy-step-3', delta: '实时正文', responseModel: 'actual-model' },
    { type: 'context', usage },
  ];
  const read = vi.spyOn(sessionsApi, 'sessionEvents').mockResolvedValue(result);
  useChat.setState({
    items: [
      { kind: 'user', id: 'old-user', text: '前一轮' },
      { kind: 'assistant', id: 'old-reply', nativeId: 'agy-step-1', text: '旧回复', streaming: false },
    ],
  });
  start('turn-one', 'agy-step-3');
  const live = { ...usage, usedTokens: 1600 };
  receive({ type: 'agent.event', turnId: 'turn-one', event: { type: 'context', usage: live } });
  finish();
  await settle();
  expect(read).toHaveBeenCalledOnce();
  expect(useChat.getState().contextUsage).toEqual(live);
  expect(useChat.getState().actualModel).toBe('当前模型');
  expect(useChat.getState().items.filter((item) => item.kind === 'assistant')).toMatchObject([
    { text: '旧回复' },
    { text: '实时正文', nativeId: 'agy-step-3', responseModel: 'actual-model' },
  ]);
  expect(useChat.getState().items.find((item) => item.id === 'old-reply')).not.toHaveProperty('responseModel');
});

it('补读不按相同正文猜模型，也不采用重复步骤的冲突报告', async () => {
  const result = history();
  result.events = [
    { type: 'text', id: 'agy-step-8', delta: '实时正文', responseModel: 'other-step-model' },
    { type: 'text', id: 'agy-step-3', delta: '实时正文', responseModel: 'conflict-one' },
    { type: 'text', id: 'agy-step-3', delta: '实时正文', responseModel: 'conflict-two' },
  ];
  vi.spyOn(sessionsApi, 'sessionEvents').mockResolvedValue(result);
  start('turn-one', 'agy-step-3');
  finish();
  await settle();
  expect(useChat.getState().items.find((item) => item.kind === 'assistant')).not.toHaveProperty('responseModel');
});

it('旧轮模型补读迟到时不串到同一时刻发送的新一轮', async () => {
  vi.useFakeTimers();
  const first = pending();
  vi.spyOn(sessionsApi, 'sessionEvents').mockReturnValueOnce(first.promise).mockResolvedValue(history());
  start('turn-one', 'agy-step-3');
  finish();
  start('turn-two', 'agy-step-5');
  finish('turn-two');
  first.resolve({
    ...history(),
    events: [{ type: 'text', id: 'agy-step-3', delta: '实时正文', responseModel: 'late-model' }],
  });
  await settle();
  expect(
    useChat
      .getState()
      .items.filter((item) => item.kind === 'assistant')
      .every((item) => !item.responseModel),
  ).toBe(true);
});
