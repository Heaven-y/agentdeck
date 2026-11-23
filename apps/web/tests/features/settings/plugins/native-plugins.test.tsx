// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NativePluginsPanel from '../../../../src/features/settings/plugins/NativePluginsPanel';
import { NativePluginDetails } from '../../../../src/features/settings/plugins/NativePluginDetails';
import { NativePluginInstall } from '../../../../src/features/settings/plugins/NativePluginInstall';
import {
  guardSettingsNavigation,
  SettingsNavigationContext,
  type SettingsNavigation,
} from '../../../../src/features/settings/navigation/settings-navigation';
import type { NativePluginCatalog, NativePluginOperation, NativePluginEntry } from '@agentdeck/shared/settings';
const task: NativePluginOperation = {
  operationId: 'op',
  revision: 'r',
  agent: 'claude',
  action: 'install',
  target: 'demo@fixture',
  source: 'fixture',
  scope: 'user',
  impact: '安装插件',
  status: 'awaiting-confirmation',
  createdAt: '2026-11-11',
  updatedAt: '2026-11-11',
  shownCommand: { command: 'fixture-tool plugin-path', sha256: 'a'.repeat(64) },
};
const catalog: NativePluginCatalog = {
  agent: 'claude',
  revision: 'catalog',
  entries: [],
  marketplaces: [],
  operations: [task],
  installScopes: ['user'],
  canInstall: true,
  canAddMarketplace: true,
  warnings: [],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const configuredEntry: NativePluginEntry = {
  id: 'entry',
  revision: 'original-entry',
  selector: 'demo@fixture',
  name: 'demo',
  source: 'fixture',
  scope: 'user',
  version: '1',
  enabled: true,
  description: '合成插件',
  components: [],
  actions: ['configure'],
};
it('切换插件详情先确认当前配置草稿，取消保留秘密而不发新详情请求', async () => {
  const guards: SettingsNavigation = new Map();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if ((input as string).includes('/detail'))
      return Response.json({
        options: [{ key: 'token', title: '令牌', description: '', sensitive: true, required: true, configured: false }],
      });
    return Response.json({
      ...catalog,
      entries: [configuredEntry, { ...configuredEntry, id: 'other', name: 'other' }],
      operations: [],
    });
  });
  render(
    <SettingsNavigationContext value={guards}>
      <NativePluginsPanel context={{ agent: 'claude' }} reload={0} onChanged={vi.fn()} />
    </SettingsNavigationContext>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '详情 · demo' }));
  fireEvent.change(await screen.findByLabelText('令牌（必填） · 未配置'), {
    target: { value: 'synthetic-private-draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: '详情 · other' }));
  expect(screen.getByLabelText<HTMLInputElement>('令牌（必填） · 未配置').value).toBe('synthetic-private-draft');
  expect(fetch.mock.calls.filter(([url]) => (url as string).includes('/detail'))).toHaveLength(1);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '详情 · other' }));
  expect((await screen.findByLabelText<HTMLInputElement>('令牌（必填） · 未配置')).value).toBe('');
});
it('空白安装表单不覆盖插件密钥草稿保护，统一导航与关闭详情均确认放弃', async () => {
  const guards: SettingsNavigation = new Map();
  const navigate = vi.fn();
  const close = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      entry: configuredEntry,
      options: [{ key: 'token', title: '令牌', description: '', sensitive: true, required: true, configured: false }],
      configurationRevision: 'configuration',
    }),
  );
  render(
    <SettingsNavigationContext value={guards}>
      <NativePluginDetails
        context={{ agent: 'claude' }}
        entry={configuredEntry}
        busy={false}
        onPrepare={vi.fn()}
        onClose={close}
      />
      <NativePluginInstall catalog={catalog} busy={false} onPrepare={vi.fn()} />
    </SettingsNavigationContext>,
  );
  fireEvent.change(await screen.findByLabelText('令牌（必填） · 未配置'), { target: { value: 'synthetic-secret' } });
  act(() => guardSettingsNavigation(guards, navigate));
  fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
  expect(navigate).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(2);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
  expect(close).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText('安装来源'), { target: { value: 'demo@fixture' } });
  confirm.mockReset().mockReturnValueOnce(true).mockReturnValueOnce(false);
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText<HTMLInputElement>('令牌（必填） · 未配置').value).toBe('synthetic-secret');
  expect(screen.getByLabelText<HTMLInputElement>('安装来源').value).toBe('demo@fixture');
});
it('安装来源草稿拒绝放弃时保留，后台原生任务不会永久锁住设置导航', () => {
  const guards: SettingsNavigation = new Map();
  const navigate = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(
    <SettingsNavigationContext value={guards}>
      <NativePluginInstall catalog={catalog} busy={true} onPrepare={vi.fn()} />
    </SettingsNavigationContext>,
  );
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText('安装来源'), { target: { value: 'demo@fixture' } });
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).toHaveBeenCalledOnce();
  expect(screen.getByLabelText<HTMLInputElement>('安装来源').value).toBe('demo@fixture');
  expect(confirm).toHaveBeenCalledOnce();
  confirm.mockReturnValue(true);
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).toHaveBeenCalledTimes(2);
});
it('配置预览后开始冲突保留原草稿和两个 revision，并同步失败任务', async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const prepared: NativePluginOperation = { ...task, action: 'configure', status: 'prepared', shownCommand: undefined };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input as string;
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url.includes('/detail'))
      return Response.json({
        entry: configuredEntry,
        options: [{ key: 'token', title: '令牌', description: '', sensitive: true, required: true, configured: false }],
        configurationRevision: 'original-config',
      });
    if (url.includes('/prepare')) return Response.json(prepared);
    if (url.includes('/start'))
      return Response.json({ code: 'revision_conflict', message: '配置已被外部修改' }, { status: 409 });
    if (url.includes('/operation')) return Response.json({ ...prepared, status: 'failed' });
    return Response.json({ ...catalog, entries: [configuredEntry], operations: [] });
  });
  render(<NativePluginsPanel context={{ agent: 'claude' }} reload={0} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '详情 · demo' }));
  fireEvent.change(await screen.findByLabelText('令牌（必填） · 未配置'), { target: { value: 'synthetic-draft' } });
  fireEvent.click(screen.getByRole('button', { name: '预览配置' }));
  fireEvent.click(await screen.findByRole('button', { name: '开始操作' }));
  await screen.findByText('配置已被外部修改');
  expect(screen.getByLabelText<HTMLInputElement>('令牌（必填） · 未配置').value).toBe('synthetic-draft');
  await screen.findByText('未开始');
  fireEvent.change(screen.getByLabelText('令牌（必填） · 未配置'), { target: { value: 'edited-draft' } });
  fireEvent.click(screen.getByRole('button', { name: '预览配置' }));
  await vi.waitFor(() => expect(calls.filter((call) => call.url.includes('/prepare'))).toHaveLength(2));
  expect(calls.filter((call) => call.url.includes('/prepare'))[1]!.body).toMatchObject({
    revision: 'original-entry',
    configurationRevision: 'original-config',
    values: { token: 'edited-draft' },
  });
  expect(calls.filter((call) => call.url.includes('/detail'))).toHaveLength(1);
});
it('配置草稿在成功终态清除，关闭重开也不恢复秘密', async () => {
  const prepared: NativePluginOperation = { ...task, action: 'configure', status: 'prepared', shownCommand: undefined };
  let status: NativePluginOperation['status'] = 'prepared';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input as string;
    if (url.includes('/detail'))
      return Response.json({
        entry: configuredEntry,
        options: [{ key: 'token', title: '令牌', description: '', sensitive: true, required: true, configured: false }],
        configurationRevision: 'original-config',
      });
    if (url.includes('/prepare')) return Response.json(prepared);
    if (url.includes('/start')) {
      status = 'succeeded';
      return Response.json({ ...prepared, status });
    }
    return Response.json({
      ...catalog,
      entries: [configuredEntry],
      operations: status === 'succeeded' ? [{ ...prepared, status }] : [],
    });
  });
  const view = render(<NativePluginsPanel context={{ agent: 'claude' }} reload={0} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '详情 · demo' }));
  fireEvent.change(await screen.findByLabelText('令牌（必填） · 未配置'), { target: { value: 'synthetic-draft' } });
  fireEvent.click(screen.getByRole('button', { name: '预览配置' }));
  await screen.findByRole('button', { name: '开始操作' });
  expect(screen.getByLabelText<HTMLInputElement>('令牌（必填） · 未配置').value).toBe('synthetic-draft');
  expect(screen.getByLabelText<HTMLInputElement>('令牌（必填） · 未配置').disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '开始操作' }));
  await screen.findByText('已完成');
  expect(screen.queryByLabelText('令牌（必填） · 未配置')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '详情 · demo' }));
  expect((await screen.findByLabelText<HTMLInputElement>('令牌（必填） · 未配置')).value).toBe('');
  fireEvent.change(screen.getByLabelText('令牌（必填） · 未配置'), { target: { value: 'another-draft' } });
  view.unmount();
  render(<NativePluginsPanel context={{ agent: 'claude' }} reload={0} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '详情 · demo' }));
  expect((await screen.findByLabelText<HTMLInputElement>('令牌（必填） · 未配置')).value).toBe('');
});
it('重开恢复原生命令确认，页面卸载不取消任务，确认发送准确摘要', async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({ url: input as string, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return Response.json(init?.method === 'POST' ? { ...task, status: 'running' } : catalog);
  });
  const view = render(<NativePluginsPanel context={{ agent: 'claude' }} reload={0} onChanged={vi.fn()} />);
  await screen.findByText('fixture-tool plugin-path');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '确认并继续' }).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('允许执行以上命令'));
  fireEvent.click(screen.getByRole('button', { name: '确认并继续' }));
  await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/start'))).toBe(true));
  expect(calls.find((c) => c.url.includes('/start'))!.body).toEqual({
    operationId: 'op',
    revision: 'r',
    confirmation: 'a'.repeat(64),
  });
  view.unmount();
  expect(calls.some((c) => c.url.includes('/cancel'))).toBe(false);
});
