// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentCapabilities, ClientMessage, FollowupSnapshot } from '@agentdeck/shared/conversation';
import { nativeActionsApi } from '../../../../src/features/chat/actions/native-actions-api';
import { NativeActionsDialog } from '../../../../src/features/chat/actions/NativeActionsDialog';
import { CollaborationModeMenu } from '../../../../src/features/chat/controls/CollaborationModeMenu';
import { startChatConnection, useChat } from '../../../../src/features/chat/state/chat-store';
import { steerAvailable } from '../../../../src/features/chat/followups/followup-state';
import { sessionsApi } from '../../../../src/features/sessions/api';
import { chatApi } from '../../../../src/features/chat/api';
import { ApiError } from '../../../../src/lib/http';
import * as sessionQueries from '../../../../src/features/sessions/queries/session-queries';

const sent: ClientMessage[] = [];
let queryClient: QueryClient;
const capabilities: AgentCapabilities = {
  agent: 'codex',
  discovered: true,
  entries: [],
  models: [],
  warnings: [],
  collaborationModes: ['default', 'plan'],
};
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  startChatConnection(() => ({
    send: (message) => {
      sent.push(message);
      return true;
    },
    reconnect() {},
    close() {},
  }));
});
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useChat.setState(useChat.getInitialState(), true);
  useChat.getState().selectWorkspace('project');
  useChat.setState({ agent: 'codex', connection: 'open', sessionId: 'native' });
  sent.length = 0;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});
function renderModes() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CollaborationModeMenu />
    </QueryClientProvider>,
  );
}
async function chooseMode(name: string) {
  fireEvent.click(screen.getByRole('button', { name: '协作模式' }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name }));
}
it('模式绑定具体会话和下轮输入，运行中改模式只可排队，不能引导暗改本轮模式', async () => {
  vi.spyOn(chatApi, 'agentCapabilities').mockResolvedValue(capabilities);
  renderModes();
  await chooseMode('计划模式');
  expect(useChat.getState().send('fixture')).toBe(true);
  expect(sent[0]).toMatchObject({ type: 'chat.send', collaborationMode: 'plan' });
  const snapshot: FollowupSnapshot = {
    queueId: 'queue',
    workspaceId: 'project',
    agent: 'codex',
    conversationId: useChat.getState().conversationId,
    sessionId: 'native',
    revision: 1,
    paused: false,
    items: [],
    canSteer: true,
  };
  useChat.setState({
    queueId: 'queue',
    turnId: 'turn',
    pendingClientTurnId: undefined,
    running: true,
    followups: { queue: { snapshot, drafts: {} } },
  });
  expect(steerAvailable(useChat.getState())).toBe(false);
  useChat.setState({
    followups: { queue: { snapshot: { ...snapshot, activeTurnId: 'turn' }, drafts: {} } },
  });
  expect(steerAvailable(useChat.getState())).toBe(true);
  await chooseMode('执行模式');
  expect(steerAvailable(useChat.getState())).toBe(false);
  expect(useChat.getState().send('next')).toBe(true);
  expect(sent.at(-1)).toMatchObject({ type: 'chat.followup', content: { collaborationMode: 'default' } });
});
it('协作模式按需读取，旧缓存不能开启模式，显式刷新只提供原生核实的选项', async () => {
  const read = vi
    .spyOn(chatApi, 'agentCapabilities')
    .mockResolvedValue({ ...capabilities, collaborationModes: undefined });
  const refresh = vi
    .spyOn(chatApi, 'refreshAgentCapabilities')
    .mockResolvedValue({ ...capabilities, collaborationModes: ['plan'] });
  renderModes();
  expect(read).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '协作模式' }));
  await screen.findByText('尚未核实可用的协作模式，可刷新原生目录。');
  expect(screen.queryByRole('menuitemradio', { name: '计划模式' })).toBeNull();
  expect(screen.queryByRole('menuitemradio', { name: '执行模式' })).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: '刷新协作模式' }));
  await screen.findByRole('menuitemradio', { name: '计划模式' });
  expect(screen.queryByRole('menuitemradio', { name: '执行模式' })).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
});
it('回退先展示真实影响再确认，预览不执行，结果刷新历史且保留输入草稿', async () => {
  vi.spyOn(nativeActionsApi, 'catalog').mockResolvedValue({
    action: 'revert-history',
    available: true,
    revision: 'a'.repeat(64),
    candidates: [{ id: 'turn', label: '第2轮及之后' }],
  });
  vi.spyOn(nativeActionsApi, 'preview').mockResolvedValue({
    token: 'token',
    action: 'revert-history',
    pointId: 'turn',
    files: [],
    removesTurns: 2,
    notice: '删除选中轮及之后，文件保留。',
    expiresAt: Date.now() + 1000,
  });
  const execute = vi
    .spyOn(nativeActionsApi, 'execute')
    .mockResolvedValue({ status: 'completed', message: '原生历史已回退' });
  const openSession = vi.fn(async () => {});
  useChat.setState({ openSession, draft: '未发草稿' });
  vi.spyOn(sessionsApi, 'sessionPermission').mockResolvedValue({ permission: null });
  render(
    <NativeActionsDialog workspaceId="project" session={{ agent: 'codex', sessionId: 'native' }} onClose={() => {}} />,
  );
  await screen.findByText('第2轮及之后');
  fireEvent.click(screen.getByRole('button', { name: '预览影响范围' }));
  await screen.findByText('将移除 2 轮原生记录。');
  expect(execute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认执行回退' }));
  await screen.findByText('原生历史已回退');
  await waitFor(() =>
    expect(openSession).toHaveBeenCalledWith({ agent: 'codex', sessionId: 'native' }, { preserveDraft: true }),
  );
  expect(useChat.getState().draft).toBe('未发草稿');
  expect(execute).toHaveBeenCalledOnce();
});

function mockPreview(expiresAt = Date.now() + 60_000) {
  vi.spyOn(nativeActionsApi, 'catalog').mockResolvedValue({
    action: 'rewind-files',
    available: true,
    revision: 'a'.repeat(64),
    candidates: [{ id: 'checkpoint', label: '原生检查点' }],
  });
  return vi.spyOn(nativeActionsApi, 'preview').mockResolvedValue({
    token: 'fixture-token',
    action: 'rewind-files',
    pointId: 'checkpoint',
    files: ['src/example.ts'],
    notice: '恢复文件，会话正文保留。',
    expiresAt,
  });
}
async function openPreview() {
  render(
    <NativeActionsDialog workspaceId="project" session={{ agent: 'claude', sessionId: 'native' }} onClose={() => {}} />,
  );
  await screen.findByText('原生检查点');
  fireEvent.click(screen.getByRole('button', { name: '预览影响范围' }));
  await screen.findByRole('button', { name: '确认执行回退' });
}
it('过期预览不可执行，返回选择后必须取得新的预览身份', async () => {
  const preview = mockPreview(Date.now() - 1);
  const execute = vi.spyOn(nativeActionsApi, 'execute');
  await openPreview();
  await screen.findByText('预览已过期，请返回重新预览。');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认执行回退' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '确认执行回退' }));
  expect(execute).not.toHaveBeenCalled();
  preview.mockResolvedValue({
    token: 'new-token',
    action: 'rewind-files',
    pointId: 'checkpoint',
    files: [],
    notice: '新的预览',
    expiresAt: Date.now() + 60_000,
  });
  fireEvent.click(screen.getByRole('button', { name: '返回选择' }));
  fireEvent.click(screen.getByRole('button', { name: '预览影响范围' }));
  await screen.findByText('新的预览');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认执行回退' }).disabled).toBe(false);
  expect(preview).toHaveBeenCalledTimes(2);
});
it.each(['partial', 'unknown'] as const)('原生返回 %s 时保留结果，刷新失败不重试执行', async (status) => {
  mockPreview();
  const execute = vi.spyOn(nativeActionsApi, 'execute').mockResolvedValue({ status, message: '原生结果需核对' });
  vi.spyOn(sessionQueries, 'refreshSessionLists').mockRejectedValue(new ApiError(500, '列表刷新失败'));
  await openPreview();
  fireEvent.click(screen.getByRole('button', { name: '确认执行回退' }));
  await screen.findByText('原生结果需核对');
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toBe('回退结果已保留，列表刷新失败。请重新打开此会话核对。');
  expect(screen.queryByRole('button', { name: '确认执行回退' })).toBeNull();
  expect(execute).toHaveBeenCalledOnce();
});
