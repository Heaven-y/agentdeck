// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, FollowupSnapshot, ServerMessage, AsyncQuestion } from '@agentdeck/shared/conversation';
import { startChatConnection, useChat } from '../../../../src/features/chat/state/chat-store';
import { Composer } from '../../../../src/features/chat/composer/Composer';
import { FollowupQueue } from '../../../../src/features/chat/followups/FollowupQueue';
import { AsyncQuestionCard } from '../../../../src/features/chat/interactions/AsyncQuestionCard';
import { chatKeys } from '../../../../src/features/chat/api';
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
      <FollowupQueue />
      <Composer />
    </QueryClientProvider>,
  );
}
it('运行中默认排队、显式引导与独立停止，IME确认不会排队', async () => {
  emit({ type: 'followup.state', snapshot: state() });
  mount();
  expect(screen.queryByText('继续输入会排队为下一轮；引导本轮仅在原生运行时支持时可用。')).toBeNull();
  expect(screen.getByRole('button', { name: '排队发送' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '引导本轮' })).toBeTruthy();
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
  fireEvent.change(input, { target: { value: '明确引导' } });
  fireEvent.click(screen.getByRole('button', { name: '引导本轮' }));
  expect(sent.at(-1)).toMatchObject({ type: 'chat.followup', mode: 'steer', turnId: 'turn' });
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  expect(sent.at(-1)).toEqual({ type: 'chat.interrupt', turnId: 'turn' });
});
it('队列编辑沿版本发送，unknown只能确认移除，清空与继续按状态启用', async () => {
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
  fireEvent.click(screen.getByText(/待发列表 ·/));
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  fireEvent.change(screen.getByLabelText('编辑待发文字'), { target: { value: '修正消息' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect(sent.at(-1)).toMatchObject({ type: 'followup.edit', revision: 4, content: { text: '修正消息' } });
  act(() =>
    emit({
      type: 'followup.state',
      snapshot: {
        ...state([{ clientMessageId: id, mode: 'steer', revision: 5, status: 'unknown', text: '未确认' }]),
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
