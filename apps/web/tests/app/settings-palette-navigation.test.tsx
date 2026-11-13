// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@agentdeck/shared/conversation';
import CommandPalette, { type PaletteActions } from '../../src/app/CommandPalette';
import { useChat } from '../../src/features/chat/chat-store';
import { sessionsApi } from '../../src/features/sessions/api';

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
  const actions: PaletteActions = {
    conversation: vi.fn(() => true),
    newSession: vi.fn(() => false),
    openSession: vi.fn(() => false),
    selectWorkspace: vi.fn(() => false),
    settings: vi.fn(() => true),
  };
  const close = vi.fn();
  const writes = {
    newSession: vi.spyOn(useChat.getState(), 'newSession'),
    openSession: vi.spyOn(useChat.getState(), 'openSession'),
    selectWorkspace: vi.spyOn(useChat.getState(), 'selectWorkspace'),
  };
  render(
    <QueryClientProvider client={client}>
      <CommandPalette workspaces={[workspace]} workspace={workspace} actions={actions} close={close} />
    </QueryClientProvider>,
  );
  return { actions, close, writes };
}

it.each([
  { label: '新会话', action: 'newSession' as const },
  { label: '原生会话', action: 'openSession' as const },
  { label: '示例项目', action: 'selectWorkspace' as const },
])('命令面板$label将完整导航交给设置保护，拒绝后不直接改动会话', async ({ label, action }) => {
  const { actions, close, writes } = mount();
  const target = await screen.findByRole('option', { name: new RegExp(label) });
  fireEvent.click(target);
  await waitFor(() => expect(actions[action]).toHaveBeenCalledOnce());
  expect(actions.conversation).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(writes.newSession).not.toHaveBeenCalled();
  expect(writes.openSession).not.toHaveBeenCalled();
  expect(writes.selectWorkspace).not.toHaveBeenCalled();
  vi.mocked(actions[action]!).mockReturnValue(true);
  fireEvent.click(target);
  expect(close).toHaveBeenCalledOnce();
  if (action === 'openSession') expect(actions.openSession).toHaveBeenLastCalledWith(session);
  if (action === 'selectWorkspace') expect(actions.selectWorkspace).toHaveBeenLastCalledWith(workspace.id);
});
