// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PluginManager from '../../../src/features/plugins/PluginManager';
import { pluginApi } from '../../../src/features/plugins/plugin-api';
import type { WorkbenchPlugin } from '@agentdeck/shared/plugins';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('安装副本保持停用，启用需明确确认且刷新真实查询缓存', async () => {
  const plugin: WorkbenchPlugin = {
    enabled: false,
    manifest: {
      id: 'fixture',
      name: '示例插件',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.html',
      permissions: ['storage'],
      commands: [],
    },
  };
  vi.spyOn(pluginApi, 'list').mockResolvedValue({ plugins: [], revision: 'missing' });
  vi.spyOn(pluginApi, 'install').mockResolvedValue({ plugins: [plugin], revision: 'installed' });
  const toggle = vi
    .spyOn(pluginApi, 'setEnabled')
    .mockResolvedValue({ plugins: [{ ...plugin, enabled: true }], revision: 'enabled' });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PluginManager onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText('本地插件目录'), { target: { value: 'fixtures/plugin' } });
  fireEvent.click(screen.getByRole('button', { name: '安装或更新插件' }));
  await screen.findByText('1.0.0 · 已停用');
  expect(toggle).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '启用 示例插件' }));
  expect(toggle).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '启用 示例插件' }));
  await waitFor(() => expect(toggle).toHaveBeenCalledExactlyOnceWith('fixture', true, 'installed'));
  expect(await screen.findByText('1.0.0 · 已启用')).toBeTruthy();
  client.clear();
});

it('停用 SSH Console 前说明影响范围，确认后才切换', async () => {
  const plugin: WorkbenchPlugin = {
    enabled: true,
    manifest: {
      id: 'ssh-console',
      name: 'SSH Console',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.html',
      permissions: [],
      commands: [],
    },
  };
  vi.spyOn(pluginApi, 'list').mockResolvedValue({ plugins: [plugin], revision: 'enabled' });
  const toggle = vi.spyOn(pluginApi, 'setEnabled').mockResolvedValue({
    plugins: [{ ...plugin, enabled: false }],
    revision: 'disabled',
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PluginManager onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  const disable = await screen.findByRole('button', { name: '停用 SSH Console' });
  fireEvent.click(disable);
  const message = confirm.mock.calls[0]?.[0] as string;
  // 页面状态随插件卸载释放；服务器档案与保存的凭据留在后端，停用不该暗示数据会消失。
  expect(message).toContain('运行服务');
  expect(message).toContain('插件数据保留');
  expect(message).not.toContain('项目服务器工具');
  expect(toggle).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(disable);
  await waitFor(() => expect(toggle).toHaveBeenCalledExactlyOnceWith('ssh-console', false, 'enabled'));
  await screen.findByRole('button', { name: '启用 SSH Console' });
  client.clear();
});

it('插件命令在所属对话框内可操作，仅在工作台接受后关闭管理器', async () => {
  const plugin: WorkbenchPlugin = {
    enabled: true,
    manifest: {
      id: 'fixture',
      name: '示例插件',
      version: '1.0.0',
      apiVersion: 2,
      entry: 'index.html',
      permissions: [],
      commands: [{ id: 'inspect', title: '查看项目' }],
    },
  };
  vi.spyOn(pluginApi, 'list').mockResolvedValue({ plugins: [plugin], revision: 'enabled' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const run = vi.fn().mockReturnValue(false);
  const close = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <PluginManager onClose={close} run={run} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '操作' }));
  const command = await screen.findByRole('menuitem', { name: '查看项目' });
  expect(screen.getByRole('dialog').contains(command)).toBe(true);
  fireEvent.click(command);
  expect(run).toHaveBeenLastCalledWith('fixture', 'inspect');
  expect(close).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toBeTruthy();
  run.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '操作' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '查看项目' }));
  expect(close).toHaveBeenCalledOnce();
  client.clear();
});
