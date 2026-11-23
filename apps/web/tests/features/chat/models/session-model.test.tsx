// @vitest-environment jsdom
import { settingsKeys } from '../../../../src/features/settings/api';
import { sessionsApi } from '../../../../src/features/sessions/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProductSettingsSchema } from '@agentdeck/shared/settings';
import { type SessionHistory, type SessionSummary } from '@agentdeck/shared/conversation';
import { Sidebar } from '../../../../src/app/sidebar/Sidebar';
import { chatKeys } from '../../../../src/features/chat/api';
import { ModelOptionsMenu } from '../../../../src/features/chat/models/ModelOptionsMenu';

import { sessionActionKey, useChat } from '../../../../src/features/chat/state/chat-store';

/** 列表行只有项目归属与标题；原生模型等元数据只在历史里出现。 */
const row = (agent: 'claude' | 'codex', sessionId: string, title: string, updatedAt: number): SessionSummary => ({
  agent,
  sessionId,
  projectId: 'workspace',
  capabilities: { rename: true, fork: 'native', delete: 'native', archive: agent === 'codex' ? 'native' : 'workbench' },
  title,
  updatedAt: new Date(updatedAt).toISOString(),
  running: false,
});
const claude = row('claude', 'same', '很长的会话标题'.repeat(10), 1);
const codex = row('codex', 'same', '另一来源', 2);
/** 历史行是原生身份，保留 summary / lastModified / nativeModel。 */
const record = (source: SessionSummary, nativeModel?: string) => ({
  agent: source.agent,
  sessionId: source.sessionId,
  summary: source.title,
  lastModified: Date.parse(source.updatedAt),
  ...(nativeModel ? { nativeModel } : {}),
});
let client: QueryClient;
beforeEach(() => {
  vi.spyOn(sessionsApi, 'sessionPermission').mockResolvedValue({ permission: null });
  useChat.setState(useChat.getInitialState(), true);
  // jsdom 缺少原生 dialog 方法；保留真实组件，只模拟开关属性。
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  useChat.getState().selectWorkspace('workspace');
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const row of [claude, codex]) {
    client.setQueryData(chatKeys.agentCapabilities('workspace', row.agent, row.sessionId), {
      agent: row.agent,
      defaultModel: 'cli-model',
      models: [],
      entries: [],
      warnings: [],
      discovered: true,
    });
  }
  client.setQueryData(settingsKeys.environment, { tools: [], checkedAt: 1 });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
const workspace = { id: 'workspace', name: '示例', dir: '~/projects/demo' };
function showList(withModel = false) {
  render(
    <QueryClientProvider client={client}>
      <Sidebar
        projects={[workspace]}
        currentProjectId={workspace.id}
        sessionsByProject={{ [workspace.id]: [claude, codex] }}
        onAddProject={vi.fn()}
      />
      {withModel && <ModelOptionsMenu disabled={false} />}
    </QueryClientProvider>,
  );
}
async function openDetails(agent: string, title: string) {
  fireEvent.click(screen.getByRole('button', { name: `${agent} 会话“${title}”的更多操作` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '重命名' }));
}
it('会话标题单行截断，列表不把来源或显式模型当作实际模型，不逐条读取历史', () => {
  const read = vi.spyOn(sessionsApi, 'sessionEvents');
  useChat.getState().setModel('requested-model');
  showList();
  expect(screen.queryByText('模型未报告')).toBeNull();
  expect(screen.getByText(claude.title).classList.contains('truncate')).toBe(true);
  expect(screen.getByText(claude.title).classList.contains('line-clamp-2')).toBe(false);
  expect(screen.queryByText('requested-model')).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
it('下一轮模型不取自历史，最近报告随同一会话保留', async () => {
  const model = 'claude-sonnet-5-long-native-id';
  const read = vi
    .spyOn(sessionsApi, 'sessionEvents')
    .mockResolvedValue({ session: record(claude), events: [], actualModel: model });
  showList(true);
  await act(() => useChat.getState().openSession(claude));
  expect(screen.getByRole('button', { name: '模型选项' }).textContent).toContain('cli-model');
  expect(screen.getByRole('button', { name: '模型选项' }).textContent).not.toContain(model);
  fireEvent.click(screen.getByRole('button', { name: '模型选项' }));
  await screen.findByText(`最近报告的模型：${model}`);
  fireEvent.click(screen.getByRole('button', { name: '模型选项' }));
  expect(screen.queryByText('模型未报告')).toBeNull();
  act(() => useChat.getState().newSession('codex'));
  expect(screen.queryByText(model)).toBeNull();
  expect(useChat.getState().sessionModels[sessionActionKey('workspace', claude)]?.actualModel).toBe(model);
  expect(useChat.getState().sessionModels[sessionActionKey('workspace', codex)]).toBeUndefined();
  await act(() => useChat.getState().openSession(claude));
  expect(screen.getByRole('button', { name: '模型选项' }).title).toContain('cli-model');
  fireEvent.click(screen.getByRole('button', { name: '模型选项' }));
  await screen.findByText(`最近报告的模型：${model}`);
  expect(read).toHaveBeenCalledTimes(1);
});
it('迟到默认不覆盖历史模型，空模型和迟到旧历史不污染另一来源', async () => {
  let resolve!: (history: SessionHistory) => void;
  vi.spyOn(sessionsApi, 'sessionEvents')
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ session: record(codex), events: [], actualModel: '  ' });
  showList();
  let old!: Promise<void>;
  act(() => {
    old = useChat.getState().openSession(claude);
  });
  await act(() => useChat.getState().openSession(codex));
  act(() => useChat.getState().setDefaults(ProductSettingsSchema.parse({ defaultAgent: 'claude' })));
  await act(async () => {
    resolve({ session: record(claude), events: [], actualModel: 'stale-model' });
    await old;
  });
  expect(screen.queryByText('模型未报告')).toBeNull();
  expect(screen.queryByText('stale-model')).toBeNull();
  expect(useChat.getState().modelOverrides.codex).toBe('');
  expect(useChat.getState().actualModel).toBeUndefined();
});
it('列表行没有原生模型字段，未读历史时详情不显示任何模型结论', async () => {
  const read = vi.spyOn(sessionsApi, 'sessionEvents');
  showList();
  expect(Object.keys(codex)).not.toContain('nativeModel');
  await openDetails('Codex', codex.title);
  expect(within(screen.getByRole('dialog')).queryByText(/^会话模型：/)).toBeNull();
  expect(within(screen.getByRole('dialog')).queryByText(/^实际模型：/)).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
it('原生会话配置不是响应报告，也不代替下一轮选择', async () => {
  vi.spyOn(sessionsApi, 'sessionEvents').mockResolvedValue({ session: record(codex, 'model-A'), events: [] });
  showList(true);
  await act(() => useChat.getState().openSession(codex));
  expect(screen.getByRole('button', { name: '模型选项' }).title).toContain('cli-model');
  fireEvent.click(screen.getByRole('button', { name: '模型选项' }));
  expect(screen.queryByText(/最近报告的模型/)).toBeNull();
  expect(useChat.getState().actualModel).toBeUndefined();
});
