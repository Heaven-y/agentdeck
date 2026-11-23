// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkbenchPlugin } from '@agentdeck/shared/plugins';
import { createPluginUiServices } from '../../../src/features/plugins/plugin-ui-services';
import { useChat } from '../../../src/features/chat/state/chat-store';
import { pluginEvents } from '../../../src/features/plugins/plugin-events';
import { usePluginPages } from '../../../src/features/plugins/use-plugin-pages';
import { pluginApi } from '../../../src/features/plugins/plugin-api';
import { PluginWorkspace } from '../../../src/features/plugins/PluginWorkspace';
import { handlePluginRequest } from '../../../src/features/plugins/plugin-bridge';

afterEach(() => {
  cleanup();
  useChat.setState(useChat.getInitialState(), true);
  vi.restoreAllMocks();
});
it('草稿修改绑定读取时的会话和内容，拒绝覆盖用户新输入及切换后的会话', () => {
  useChat.setState({ draft: '原文', conversationId: 'first' });
  const ui = createPluginUiServices();
  const first = ui.readDraft('first');
  useChat.getState().setDraft('用户新输入');
  expect(() => ui.writeDraft({ text: '被覆盖', revision: first.revision })).toThrow('变化');
  const second = ui.readDraft();
  useChat.setState({ conversationId: 'second' });
  expect(() => ui.writeDraft({ text: '被覆盖', revision: second.revision })).toThrow('变化');
  expect(() => ui.readDraft('first')).toThrow('切换');
  expect(useChat.getState().draft).toBe('用户新输入');
  const third = ui.readDraft();
  ui.writeDraft({ text: '新草稿', revision: third.revision });
  expect(useChat.getState().draft).toBe('新草稿');
  expect(() => ui.writeDraft({ text: '再次写入', revision: third.revision })).toThrow('变化');
});
it('切换到后台的会话仍收到轮次结束，切换页面不会伪造轮次事件', () => {
  const initial = { ...useChat.getInitialState(), conversationId: 'first', running: true };
  const other = { ...initial, conversationId: 'second', running: false, background: { first: initial } };
  expect(pluginEvents(other, initial).map((event) => event.name)).toEqual(['context.changed']);
  const completed = { ...other, background: { first: { ...initial, running: false } } };
  expect(pluginEvents(completed, other)).toEqual([
    {
      name: 'turn.completed',
      session: {
        conversationId: 'first',
        agent: 'claude',
        workspaceId: undefined,
        sessionId: undefined,
        running: false,
      },
    },
  ]);
});
const extension: WorkbenchPlugin = {
  enabled: true,
  manifest: {
    id: 'helper',
    name: '助手',
    version: '1.0.0',
    apiVersion: 2,
    entry: 'index.html',
    permissions: ['composer'],
    commands: [{ id: 'insert', title: '插入说明', execution: 'background' }],
    contributes: { pages: [], actions: [{ command: 'insert', location: 'composer' }] },
  },
};
it('项目切换尚未提交界面时，插件不能读取旧项目并误认为新会话的目录', async () => {
  useChat.setState({ workspaceId: 'new-project' });
  const manifest = { ...extension.manifest, permissions: ['project-context' as const] };
  const result = await handlePluginRequest(
    manifest,
    { type: 'agentdeck.plugin.request', id: 'request', method: 'project.get' },
    { project: { id: 'old-project', name: '旧项目', dir: 'fixtures' }, ui: createPluginUiServices() },
  );
  expect(result).toBeNull();
});
it('后台命令按需加载，页面就绪后仅交付一次，处理命令不切离对话', async () => {
  vi.spyOn(pluginApi, 'list').mockResolvedValue({ plugins: [extension], revision: 'missing' });
  vi.spyOn(pluginApi, 'page').mockResolvedValue({ html: '<h1>助手</h1>' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const plugins = usePluginPages();
    return (
      <>
        <button disabled={!plugins.list.length} onClick={() => plugins.run('helper', 'insert')}>
          调用
        </button>
        <span>{plugins.selected ?? '对话'}</span>
        <PluginWorkspace
          plugin={plugins.active}
          enabledPlugins={plugins.enabledPlugins}
          close={() => plugins.show()}
          invocations={plugins.invocations}
          delivered={plugins.delivered}
        />
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '调用' }).disabled).toBe(false));
  expect(screen.queryByTitle('助手')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '调用' }));
  const frame = await screen.findByTitle<HTMLIFrameElement>('助手');
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent('message', { source: frame.contentWindow, data: { type: 'agentdeck.plugin.ready' } }),
    ),
  );
  await waitFor(() =>
    expect(post.mock.calls.filter(([data]) => data.type === 'agentdeck.plugin.command')).toHaveLength(1),
  );
  expect(post.mock.calls.find(([data]) => data.type === 'agentdeck.plugin.command')?.[0]).not.toHaveProperty('session');
  expect(screen.getByText('对话')).toBeTruthy();
  expect(screen.getByTitle('助手')).toBe(frame);
  client.clear();
});
