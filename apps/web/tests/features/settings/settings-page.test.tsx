// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ProductSettingsSchema } from '@agentdeck/shared/settings';
import SettingsDialog from '../../../src/features/settings/SettingsDialog';
import { queryClient } from '../../../src/lib/query-client';

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});
const project = { id: 'demo', name: '演示项目', dir: '~/projects/demo' };
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
function mockMemoryResponse(url: string, init?: RequestInit): Response {
  const project = url.includes('projectId=demo');
  const payload = typeof init?.body === 'string' ? (JSON.parse(init.body) as { override: Override }) : undefined;
  const override = payload?.override === 'enabled' ? true : payload?.override === 'disabled' ? false : null;
  return Response.json({
    scope: project ? 'project' : 'user',
    enabled: override ?? true,
    override,
    localOverride: null,
    userEnabled: true,
  });
}
type Override = 'inherit' | 'enabled' | 'disabled';
function mockApi() {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.includes('/claude-memory')) return mockMemoryResponse(url, init);
    if (url.includes('/product'))
      return Response.json({ settings: ProductSettingsSchema.parse({}), revision: 'missing' });
    if (url.includes('/native-resources/'))
      return Response.json({ agent: 'claude', entries: [], roots: [], warnings: [], guidance: [] });
    if (url.includes('/skills')) return Response.json({ agent: 'claude', entries: [], roots: [], warnings: [] });
    if (url.includes('/mcp'))
      return Response.json({ agent: 'claude', entries: [], sources: [], warnings: [], instances: [] });
    if (url.includes('/catalog')) return Response.json({ models: [], entries: [], warnings: [] });
    return Response.json({ agent: 'claude', revision: 'missing', fields: [], warnings: [] });
  });
}
it('设置直接展示管理分类，选择CLI与项目后进入对应管理页且不用弹窗', async () => {
  const fetch = mockApi();
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsDialog project={project} projects={[project]} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  await screen.findByLabelText('默认 Agent');
  expect(screen.queryByRole('dialog')).toBeNull();
  const nav = screen.getByRole('navigation', { name: '设置分类' });
  for (const name of ['通用设置', '模型与连接', 'Skills', 'MCP', '原生插件', '原生文件', '记忆', '运行环境'])
    expect(within(nav).getByRole('button', { name })).toBeTruthy();
  fireEvent.click(within(nav).getByRole('button', { name: 'Skills' }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([url]) => (url as string).includes('/native-management/claude/skills?projectId=demo')),
    ).toBe(true),
  );
  const scrollport = screen
    .getByRole('region', { name: '设置页面' })
    .querySelector<HTMLElement>('.settings-main > div:last-child')!;
  scrollport.scrollTop = 720;
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  await waitFor(() => expect(scrollport.scrollTop).toBe(0));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([url]) => (url as string).includes('/native-management/codex/skills?projectId=demo')),
    ).toBe(true),
  );
  fireEvent.change(screen.getByLabelText('资源范围'), { target: { value: '' } });
  await waitFor(() =>
    expect(fetch.mock.calls.some(([url]) => (url as string) === '/api/native-management/codex/skills')).toBe(true),
  );
  fireEvent.click(within(nav).getByRole('button', { name: 'MCP' }));
  await waitFor(() =>
    expect(fetch.mock.calls.some(([url]) => (url as string) === '/api/native-management/codex/mcp')).toBe(true),
  );
});
it('记忆页按原生范围切换 Claude Auto Memory，其他 CLI 链接到原生文件', async () => {
  const fetch = mockApi();
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsDialog project={project} projects={[project]} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  const nav = screen.getByRole('navigation', { name: '设置分类' });
  fireEvent.click(within(nav).getByRole('button', { name: '记忆' }));
  const scope = await screen.findByLabelText<HTMLSelectElement>('记忆范围');
  expect(scope.value).toBe('demo');
  const projectSetting = await screen.findByLabelText<HTMLSelectElement>('共享项目设置');
  fireEvent.change(projectSetting, { target: { value: 'disabled' } });
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([url, init]) =>
          requestUrl(url).includes('/api/settings/claude-memory?projectId=demo') &&
          init?.method === 'PUT' &&
          typeof init.body === 'string' &&
          JSON.stringify(JSON.parse(init.body)) === JSON.stringify({ scope: 'project', override: 'disabled' }),
      ),
    ).toBe(true),
  );

  fireEvent.change(scope, { target: { value: '' } });
  const userSetting = await screen.findByLabelText<HTMLInputElement>('启用自动记忆');
  expect(userSetting.checked).toBe(true);
  fireEvent.click(userSetting);
  await waitFor(() => expect(userSetting.checked).toBe(false));

  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  expect(await screen.findByText(/没有确认可独立控制的自动记忆开关/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '打开原生文件' }));
  await screen.findByRole('heading', { name: '原生配置与扩展 · Codex' });
});
it('一级分类和返回工作台均保护未保存设置，确认后离开', async () => {
  mockApi();
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const close = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsDialog onClose={close} />
    </QueryClientProvider>,
  );
  fireEvent.change(await screen.findByLabelText('默认 Agent'), { target: { value: 'codex' } });
  fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText<HTMLSelectElement>('默认 Agent').value).toBe('codex');
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
  expect(close).toHaveBeenCalledOnce();
});
