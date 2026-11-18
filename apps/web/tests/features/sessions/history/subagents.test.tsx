// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChat } from '../../../../src/features/chat/state/chat-store';
import { SubagentHistoryButton } from '../../../../src/features/sessions/history/SubagentHistoryDialog';
import { sessionsApi } from '../../../../src/features/sessions/api';

vi.mock('../../../../src/features/chat/timeline/ChatTimeline', () => ({
  ChatTimeline: ({ items }: { items: unknown[] }) => <div>{JSON.stringify(items)}</div>,
}));
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
  useChat.setState(useChat.getInitialState(), true);
  useChat.getState().selectWorkspace('project');
  useChat.setState({ agent: 'claude', sessionId: 'parent' });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
function mount() {
  render(
    <QueryClientProvider client={client}>
      <SubagentHistoryButton />
    </QueryClientProvider>,
  );
}
it('打开后才读取子代理，分页追加但不写主对话，切换子代理不串内容', async () => {
  const api = vi.spyOn(sessionsApi, 'subagents').mockImplementation(async (_workspace, _session, query) => {
    if (!query.agentId) return { agentIds: ['child-a', 'child-b'] };
    return {
      agentId: query.agentId,
      events: [{ type: 'text', delta: `${query.agentId}-${query.cursor ?? 'first'}` }],
      nextCursor: query.cursor ? undefined : '100',
    };
  });
  const parentItems = useChat.getState().items;
  mount();
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '子代理' }));
  await screen.findByText(/child-a-first/);
  fireEvent.click(screen.getByRole('button', { name: '继续加载' }));
  await screen.findByText(/child-a-100/);
  fireEvent.change(screen.getByRole('combobox', { name: '选择子代理' }), { target: { value: 'child-b' } });
  await screen.findByText(/child-b-first/);
  expect(screen.queryByText(/child-a-first/)).toBeNull();
  expect(useChat.getState().items).toBe(parentItems);
  fireEvent.click(screen.getByRole('button', { name: '关闭子代理历史' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('三CLI共享摘要与嵌套入口，返回上级后保持根会话身份', async () => {
  useChat.setState({ agent: 'codex' });
  const api = vi.spyOn(sessionsApi, 'subagents').mockImplementation(async (_workspace, _session, query) => {
    if (!query.agentId)
      return {
        agentIds: [query.parentAgentId ? 'nested' : 'child'],
        summaries: [
          {
            agentId: query.parentAgentId ? 'nested' : 'child',
            parentSessionId: 'parent',
            parentAgentId: query.parentAgentId,
            name: '阅读者',
            role: '检查源码',
            status: 'running',
          },
        ],
      };
    return {
      agentId: query.agentId,
      parentAgentId: query.parentAgentId,
      events: [{ type: 'text', delta: `${query.agentId}独立内容` }],
    };
  });
  mount();
  fireEvent.click(screen.getByRole('button', { name: '子代理' }));
  await screen.findByText('child独立内容', { exact: false });
  expect(screen.getByText('检查源码')).toBeTruthy();
  expect(screen.getByText('运行中')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '查看其子代理' }));
  await screen.findByText('nested独立内容', { exact: false });
  fireEvent.click(screen.getByRole('button', { name: '返回主会话子代理' }));
  await screen.findByText('child独立内容', { exact: false });
  expect(api.mock.calls.every((call) => call[1] === 'parent' && call[3]?.agent === 'codex')).toBe(true);
});
it('切换CLI后迟到目录不会串入新入口', async () => {
  let finish!: (value: { agentIds: string[] }) => void;
  vi.spyOn(sessionsApi, 'subagents').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: '子代理' }));
  useChat.setState({ agent: 'antigravity' });
  finish({ agentIds: ['old-child'] });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByText('old-child')).toBeNull();
});
it('历史API按选定CLI构造请求，嵌套导航保持根会话URL', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ agentIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  await sessionsApi.subagents('project', 'root', { parentAgentId: 'child' }, { agent: 'antigravity' });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    '/api/projects/project/sessions/antigravity/root/subagents?parentAgentId=child',
  );
});
