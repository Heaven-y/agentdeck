import { beforeAll, beforeEach, expect, it, vi, afterEach } from 'vitest';
import type {
  AsyncQuestion,
  ClientMessage,
  ServerMessage,
  FollowupSnapshot,
  RecoveryNotice,
} from '@agentdeck/shared/conversation';
import { startChatConnection, useChat } from '../../../src/features/chat/chat-store';
import { reduceChat } from '../../../src/features/chat/chat-reducer';
import { sessionsApi } from '../../../src/features/sessions/api';
const question: AsyncQuestion = {
  sessionId: 'session',
  messageId: 'question',
  spec: {
    kind: 'questions',
    blocking: false,
    title: '补充信息',
    fields: [{ id: 'q', type: 'text', label: '范围？', required: true }],
  },
};
let emit!: (message: ServerMessage) => void;
let recovery!: (notice: RecoveryNotice) => void;
const sent: ClientMessage[] = [];
let acknowledge = false;
beforeAll(() =>
  startChatConnection((handlers) => {
    emit = handlers.onMessage;
    recovery = handlers.onRecovery!;
    return {
      send: (message) => {
        sent.push(message);
        if (acknowledge && message.type === 'question.respond')
          emit({
            type: 'followup.state',
            snapshot: {
              queueId: '00000000-0000-4000-8000-000000000001',
              workspaceId: 'project',
              agent: 'codex',
              conversationId: message.conversationId,
              sessionId: 'session',
              revision: 1,
              paused: false,
              items: [],
              questions: [{ question, status: 'queued' }],
            },
          });
        return true;
      },
      close() {},
      reconnect() {},
    };
  }),
);
beforeEach(() => {
  sent.length = 0;
  useChat.setState(useChat.getInitialState(), true);
  useChat.getState().selectWorkspace('project');
  useChat.setState({ connection: 'open', agent: 'codex', sessionId: 'session' });
});
afterEach(() => vi.restoreAllMocks());
it('idle问题未获回执后身份失效保留答案，显式核题确认未答才允许重试且不自动发送', async () => {
  useChat.setState({ items: reduceChat([], { type: 'async_question', question }), draft: '主草稿' });
  const answer = { action: 'submit' as const, values: { q: '已填写答案' } };
  useChat.getState().respondAsyncQuestion(question, answer);
  recovery({ type: 'connection.rejected', code: 'owner_missing', message: '已失效' });
  recovery({ type: 'connection.ready', sequence: 0, acceptedClientTurnIds: [] });
  expect(useChat.getState().items[0]).toMatchObject({ responding: false, answer, recovery: expect.any(Object) });
  expect(useChat.getState().respondAsyncQuestion(question, answer)).toBe(false);
  const count = sent.length;
  vi.spyOn(sessionsApi, 'sessionEvents').mockResolvedValue({
    session: { agent: 'codex', sessionId: 'session', summary: '合成', lastModified: 0 },
    events: [{ type: 'async_question', question }],
  });
  await useChat.getState().verifyAsyncQuestion(question);
  expect(sent).toHaveLength(count);
  expect(useChat.getState().items[0]).toMatchObject({ status: 'open', answer, recovery: undefined });
  expect(useChat.getState().draft).toBe('主草稿');
  expect(useChat.getState().respondAsyncQuestion(question, answer)).toBe(true);
});
it('失效答复核题已答只收敛卡片，迟到旧核题不能解锁新失效状态', async () => {
  useChat.setState({ items: reduceChat([], { type: 'async_question', question }) });
  useChat.getState().respondAsyncQuestion(question, { action: 'submit', values: { q: '答案' } });
  recovery({ type: 'connection.rejected', code: 'owner_missing', message: '已失效' });
  let resolve!: (value: Awaited<ReturnType<typeof sessionsApi.sessionEvents>>) => void;
  const history = vi.spyOn(sessionsApi, 'sessionEvents').mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = useChat.getState().verifyAsyncQuestion(question);
  recovery({ type: 'connection.rejected', code: 'owner_missing', message: '再次失效' });
  resolve({
    session: { agent: 'codex', sessionId: 'session', summary: '合成', lastModified: 0 },
    events: [{ type: 'async_question', question }],
  });
  await pending;
  expect(useChat.getState().items[0]).toMatchObject({ recovery: expect.any(Object) });
  history.mockResolvedValue({
    session: { agent: 'codex', sessionId: 'session', summary: '合成', lastModified: 0 },
    events: [{ type: 'async_question', question, answered: true }],
  });
  await useChat.getState().verifyAsyncQuestion(question);
  expect(useChat.getState().items[0]).toMatchObject({ status: 'accepted', responding: false, recovery: undefined });
  expect(sent).toHaveLength(1);
});
it('即时答复确认不被发送时的旧卡片状态覆盖', () => {
  useChat.setState({ items: reduceChat([], { type: 'async_question', question }) });
  acknowledge = true;
  try {
    useChat.getState().respondAsyncQuestion(question, { action: 'submit', values: { q: '核心' } });
  } finally {
    acknowledge = false;
  }
  expect(useChat.getState().items[0]).toMatchObject({ status: 'queued', responding: false });
});
it('异步题按原生身份去重，结束回合不取消，原生已回答只更新原卡片', () => {
  let items = reduceChat([], { type: 'async_question', question });
  items = reduceChat(items, { type: 'async_question', question });
  items = reduceChat(items, { type: 'turn_end', isError: false });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: 'async-question', question, status: 'open' });
  expect(reduceChat(items, { type: 'async_question', question, answered: true })[0]).toMatchObject({
    status: 'accepted',
  });
});
it('结束后回答走独立追加协议，后台错误只恢复所属题目，不覆盖主草稿', () => {
  const origin = useChat.getState().conversationId;
  useChat.setState({ items: reduceChat([], { type: 'async_question', question }), draft: '已有草稿' });
  expect(useChat.getState().respondAsyncQuestion(question, { action: 'submit', values: { q: '核心' } })).toBe(true);
  expect(sent[0]).toMatchObject({
    type: 'question.respond',
    workspaceId: 'project',
    agent: 'codex',
    sessionId: 'session',
    conversationId: origin,
    messageId: 'question',
    answer: { action: 'submit', values: { q: '核心' } },
  });
  expect(useChat.getState().respondAsyncQuestion(question, { action: 'submit', values: { q: '重复' } })).toBe(false);
  useChat.getState().newSession('claude');
  emit({
    type: 'question.error',
    workspaceId: 'project',
    agent: 'codex',
    sessionId: 'session',
    messageId: 'question',
    message: '请核对',
  });
  expect(useChat.getState().background[origin]!.items[0]).toMatchObject({ status: 'open', error: '请核对' });
  expect(useChat.getState().background[origin]!.draft).toBe('已有草稿');
});
it('快照跟踪已排队题目，历史已答题不允许再发，取消仅关闭本页', () => {
  useChat.setState({ items: reduceChat([], { type: 'async_question', question }) });
  const snapshot: FollowupSnapshot = {
    queueId: '00000000-0000-4000-8000-000000000001',
    workspaceId: 'project',
    agent: 'codex',
    conversationId: useChat.getState().conversationId,
    sessionId: 'session',
    revision: 1,
    paused: false,
    items: [],
    questions: [{ question, status: 'queued' }],
  };
  emit({ type: 'followup.state', snapshot });
  expect(useChat.getState().items[0]).toMatchObject({ status: 'queued' });
  expect(useChat.getState().respondAsyncQuestion(question, { action: 'submit', values: { q: '重复' } })).toBe(false);
  useChat.setState({ items: reduceChat([], { type: 'async_question', question, answered: true }) });
  expect(useChat.getState().respondAsyncQuestion(question, { action: 'submit', values: { q: '重复' } })).toBe(false);
  useChat.getState().dismissAsyncQuestion(question);
  expect(sent).toEqual([]);
});
