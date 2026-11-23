// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@agentdeck/shared/conversation';
import SessionSearch from '../../../src/app/navigation/SessionSearch';
import { useChat } from '../../../src/features/chat/state/chat-store';
import { sessionsApi } from '../../../src/features/sessions/api';

const workspace = { id: 'demo', name: '示例项目', dir: 'demo' };
const session: SessionSummary = {
  agent: 'codex',
  sessionId: 'native-session',
  title: '原生会话',
  projectId: workspace.id,
  updatedAt: '2026-11-05T00:00:00Z',
  running: false,
};
let client: QueryClient;

beforeEach(() => {
  useChat.setState({ ...useChat.getInitialState(), workspaceId: workspace.id }, true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(sessionsApi, 'page').mockImplementation(async ({ agent }) => ({
    items: agent === 'codex' ? [session] : [],
  }));
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  client.clear();
  useChat.setState(useChat.getInitialState(), true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const open = vi.fn(() => false);
  const close = vi.fn();
  const writes = {
    newSession: vi.spyOn(useChat.getState(), 'newSession'),
    openSession: vi.spyOn(useChat.getState(), 'openSession'),
    selectWorkspace: vi.spyOn(useChat.getState(), 'selectWorkspace'),
  };
  render(
    <QueryClientProvider client={client}>
      <SessionSearch projects={[workspace]} open={open} close={close} />
    </QueryClientProvider>,
  );
  return { open, close, writes };
}

it('会话搜索将导航交给设置保护，拒绝后不直接改动会话，也不混入常用操作', async () => {
  const { open, close, writes } = mount();
  const target = await screen.findByRole('option', { name: /原生会话/ });
  expect(screen.queryByRole('option', { name: '新会话' })).toBeNull();
  expect(screen.queryByRole('option', { name: '打开设置' })).toBeNull();
  fireEvent.click(target);
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(close).not.toHaveBeenCalled();
  expect(writes.newSession).not.toHaveBeenCalled();
  expect(writes.openSession).not.toHaveBeenCalled();
  expect(writes.selectWorkspace).not.toHaveBeenCalled();
  open.mockReturnValue(true);
  fireEvent.click(target);
  expect(close).toHaveBeenCalledOnce();
  expect(open).toHaveBeenLastCalledWith(workspace.id, session);
});
