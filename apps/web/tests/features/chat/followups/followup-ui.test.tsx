// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, FollowupSnapshot, ServerMessage, AsyncQuestion } from '@agentdeck/shared/conversation';
import { startChatConnection, useChat } from '../../../../src/features/chat/state/chat-store';
import { Composer } from '../../../../src/features/chat/composer/Composer';
import { AsyncQuestionCard } from '../../../../src/features/chat/interactions/AsyncQuestionCard';
import { chatKeys } from '../../../../src/features/chat/api';
import { historyItems } from '../../../../src/features/conversation/model/conversation-events';
const sent: ClientMessage[] = [];
let emit!: (message: ServerMessage) => void;
const queueId = '00000000-0000-4000-8000-000000000001';
let client: QueryClient;
beforeAll(() =>
  startChatConnection((handlers) => {
    emit = handlers.onMessage;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      reconnect() {},
      close() {},
    };
  }),
);
beforeEach(() => {
  sent.length = 0;
  useChat.setState(useChat.getInitialState(), true);
  useChat.getState().selectWorkspace('project');
  useChat.setState({
    connection: 'open',
    agent: 'codex',
    sessionId: 'session',
    running: true,
    turnId: 'turn',
    runningInput: { text: '本轮' },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(chatKeys.agentCapabilities('project', 'codex'), {
    agent: 'codex',
    entries: [],
    models: [],
    warnings: [],
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
const state = (items: FollowupSnapshot['items'] = []): FollowupSnapshot => ({
  queueId,
  workspaceId: 'project',
  agent: 'codex',
  conversationId: useChat.getState().conversationId,
  sessionId: 'session',
  revision: 1,
  paused: false,
  canSteer: true,
  activeTurnId: 'turn',
  items,
});
function mount() {
  render(
    <QueryClientProvider client={client}>
      <Composer />
    </QueryClientProvider>,
  );
}
it('待发因结果冲突暂停时就地查看原因，清空后不留下页脚提醒', () => {
  const items = historyItems([
    { type: 'user_message', text: '本轮请求' },
    { type: 'text', delta: '本轮回复' },
    { type: 'turn_end', isError: true, outcome: 'unconfirmed' },
  ]);
  useChat.setState({ items, running: false });
  emit({
    type: 'followup.state',
    snapshot: {
      ...state([{ clientMessageId: 'queued-next', revision: 0, mode: 'queue', status: 'queued', text: '下一条' }]),
      paused: true,
      reason: '本轮原生结果未确认，待发列表已暂停。',
    },
  });
  mount();
  const queue = screen.getByRole('region', { name: '待发列表' });
  expect(within(queue).getByText('本轮原生结果未确认，待发列表已暂停。')).toBeTruthy();
  fireEvent.click(within(queue).getByRole('button', { name: '查看待发暂停原因' }));
  expect(useChat.getState().inspectedItemId).toBe(items.find((item) => item.kind === 'turn-status')!.id);
  expect(sent).toEqual([]);
  const paused = useChat.getState().followups[queueId]!.snapshot;
  act(() =>
    emit({
      type: 'followup.state',
      snapshot: { ...paused, revision: 2, reason: '连接已断开，待发列表已暂停；恢复连接后可继续。' },
    }),
  );
  expect(within(queue).getByText('连接已断开，待发列表已暂停；恢复连接后可继续。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '查看待发暂停原因' })).toBeNull();
  act(() => emit({ type: 'followup.state', snapshot: { ...state(), revision: 3, paused: true } }));
  expect(screen.queryByRole('region', { name: '待发列表' })).toBeNull();
  expect(screen.queryByText('结果待核实')).toBeNull();
});
it('按原生身份认领的队列可见且恢复到当前视图，投递不会另造重复会话', () => {
  const currentId = useChat.getState().conversationId;
  useChat.setState({ permission: { agent: 'codex', mode: 'ask' } });
  emit({
    type: 'followup.state',
    snapshot: {
      ...state([
        {
          clientMessageId: '00000000-0000-4000-8000-000000000002',
          revision: 0,
          mode: 'queue',
          status: 'unknown',
          text: '待核对文字',
          content: { text: '待核对文字', model: 'queued-model', permission: { agent: 'codex', mode: 'full-access' } },
        },
      ]),
      conversationId: 'previous-view',
      paused: true,
    },
  });
  mount();
  expect(screen.getByText('待核对文字')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '恢复到草稿' }));
  expect(useChat.getState()).toMatchObject({
    conversationId: currentId,
    draft: '待核对文字',
    permission: { agent: 'codex', mode: 'ask' },
    modelOverrides: { codex: 'queued-model' },
  });
  act(() =>
    emit({
      type: 'turn.started',
      turnId: 'next-turn',
      clientTurnId: 'next-attempt',
      workspaceId: 'project',
      agent: 'codex',
      queueId,
      input: {
        type: 'chat.send',
        workspaceId: 'project',
        agent: 'codex',
        conversationId: 'previous-view',
        sessionId: 'session',
        clientTurnId: 'next-attempt',
        text: '已确认的下一轮',
      },
    }),
  );
  expect(useChat.getState()).toMatchObject({ conversationId: currentId, turnId: 'next-turn' });
  expect(useChat.getState().background['previous-view']).toBeUndefined();
  expect(sent).toEqual([]);
});
it('运行中默认排队、显式引导与独立停止，IME确认不会排队', async () => {
  emit({ type: 'followup.state', snapshot: state() });
  mount();
  expect(screen.queryByText('继续输入会排队为下一轮；引导本轮仅在原生运行时支持时可用。')).toBeNull();
  expect(screen.queryByRole('button', { name: '排队发送' })).toBeNull();
  expect(screen.queryByRole('button', { name: '引导本轮' })).toBeNull();
  const input = screen.getByLabelText('输入消息');
  fireEvent.change(input, { target: { value: '输入法消息' } });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  expect(sent).toEqual([]);
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(sent.at(-1)).toMatchObject({ type: 'chat.followup', mode: 'queue' });
  const message = sent.at(-1) as Extract<ClientMessage, { type: 'chat.followup' }>;
  act(() =>
    emit({
      type: 'followup.state',
      snapshot: state([
        {
          clientMessageId: message.clientMessageId,
          mode: 'queue',
          revision: 0,
          status: 'queued',
          text: message.content.text,
          content: message.content,
        },
      ]),
    }),
  );
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
  fireEvent.click(screen.getByRole('button', { name: '引导本轮' }));
  expect(sent.at(-1)).toMatchObject({
    type: 'followup.steer',
    clientMessageId: message.clientMessageId,
    revision: 0,
    turnId: 'turn',
  });
  fireEvent.change(input, { target: { value: '明确引导' } });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(sent.at(-1)).toMatchObject({ type: 'chat.followup', mode: 'steer', turnId: 'turn' });
  act(() => emit({ type: 'followup.state', snapshot: { ...state(), canSteer: false, revision: 2 } }));
  const count = sent.length;
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(sent).toHaveLength(count);
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  expect(sent.at(-1)).toEqual({ type: 'chat.interrupt', turnId: 'turn' });
});
it('待发项收到取回确认才回到输入框，保留已有草稿；未知受理仍须确认移除', () => {
  const id = '00000000-0000-4000-8000-000000000002';
  emit({
    type: 'followup.state',
    snapshot: {
      ...state([
        {
          clientMessageId: id,
          mode: 'queue',
          revision: 4,
          status: 'failed',
          text: '失败消息',
          content: { text: '失败消息' },
        },
      ]),
      paused: true,
    },
  });
  mount();
  const input = screen.getByLabelText<HTMLTextAreaElement>('输入消息');
  fireEvent.change(input, { target: { value: '现有草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  expect(sent.at(-1)).toMatchObject({ type: 'followup.cancel', revision: 4, returnToDraft: true });
  expect(input.value).toBe('现有草稿');
  expect(document.activeElement).toBe(input);
  act(() =>
    emit({
      type: 'followup.state',
      snapshot: {
        ...state([
          {
            clientMessageId: id,
            mode: 'queue',
            revision: 5,
            status: 'cancelled',
            text: '失败消息',
            returnedToDraft: true,
          },
        ]),
        revision: 2,
        paused: true,
      },
    }),
  );
  expect(input.value).toBe('失败消息');
  expect(useChat.getState().draftBackups.map(({ text }) => text)).toEqual(['现有草稿']);
  act(() =>
    emit({
      type: 'followup.state',
      snapshot: {
        ...state([{ clientMessageId: 'unknown', mode: 'steer', revision: 5, status: 'unknown', text: '未确认' }]),
        revision: 3,
        paused: true,
      },
    }),
  );
  expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '继续列表' }).disabled).toBe(true);
  const count = sent.length;
  fireEvent.click(screen.getByRole('button', { name: '移除' }));
  expect(sent).toHaveLength(count);
  expect(screen.getByText(/移除记录不会撤回/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认仅移除记录' }));
  expect(sent.at(-1)).toMatchObject({ type: 'followup.cancel', revision: 5 });
});
it('异步问题复用表单，明确非阻塞并保留错误后的回答输入', () => {
  const question: AsyncQuestion = {
    sessionId: 'session',
    messageId: 'question',
    spec: {
      kind: 'questions',
      title: '补充范围',
      blocking: false,
      fields: [{ id: 'q', type: 'text', label: '范围', required: true }],
    },
  };
  const item = { kind: 'async-question' as const, id: 'question', question, status: 'open' as const };
  useChat.setState({ items: [item], running: false });
  const component = render(<AsyncQuestionCard item={item} />);
  expect(screen.getByText(/非阻塞问题/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('范围'), { target: { value: '核心代码' } });
  fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
  expect(sent.at(-1)).toMatchObject({ type: 'question.respond' });
  component.rerender(<AsyncQuestionCard item={{ ...item, error: '请重试' }} />);
  expect(screen.getByLabelText<HTMLInputElement>('范围').value).toBe('核心代码');
  expect(within(screen.getByRole('alert')).getByText('请重试')).toBeTruthy();
});
