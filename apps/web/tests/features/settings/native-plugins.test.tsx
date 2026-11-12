// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NativePluginsPanel from '../../../src/features/settings/NativePluginsPanel';
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
  fireEvent.click(screen.getByLabelText('我已核对上述原生命令'));
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
