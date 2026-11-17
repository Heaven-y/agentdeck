// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NativeMcpPanel from '../../../src/features/settings/NativeMcpPanel';
import NativeMcpEditor from '../../../src/features/settings/NativeMcpEditor';
import {
  guardSettingsNavigation,
  SettingsNavigationContext,
  type SettingsNavigation,
} from '../../../src/features/settings/settings-navigation';
import type { NativeMcpCatalog } from '@agentdeck/shared/settings';
import { queryClient } from '../../../src/lib/query-client';
import NativeResourcesDialog from '../../../src/features/settings/NativeResourcesDialog';
const catalog: NativeMcpCatalog = {
  agent: 'codex',
  warnings: [],
  sources: [
    {
      id: 'source',
      revision: 'original',
      scope: 'user',
      label: '用户配置',
      transports: ['stdio', 'http'],
      writable: true,
      secretInput: true,
    },
  ],
  entries: [
    {
      id: 'entry',
      sourceId: 'source',
      revision: 'original',
      name: 'demo',
      scope: 'user',
      source: '用户配置',
      transport: 'http',
      enabled: true,
      runtime: 'unchecked',
      config: {
        argsConfigured: false,
        urlConfigured: true,
        urlOrigin: 'https://example.com',
        envKeys: [],
        headerKeys: ['Authorization'],
      },
      actions: { edit: true, delete: true, enable: true, disable: true },
    },
  ],
};
afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  queryClient.clear();
  vi.restoreAllMocks();
});
const sessionStatus = (enabled = false) => ({ agent: 'codex', enabled, available: true, revision: 'original' });
it('MCP 密钥草稿在统一导航与局部取消时确认放弃，保存期间阻止离开', async () => {
  const guards: SettingsNavigation = new Map();
  const close = vi.fn();
  const navigate = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  render(
    <SettingsNavigationContext value={guards}>
      <NativeMcpEditor
        context={{ agent: 'codex' }}
        source={catalog.sources[0]!}
        entry={catalog.entries[0]}
        onClose={close}
        onSaved={vi.fn()}
      />
    </SettingsNavigationContext>,
  );
  fireEvent.change(screen.getByLabelText('Authorization 操作'), { target: { value: 'replace' } });
  fireEvent.change(screen.getByLabelText('Authorization 新值'), { target: { value: 'synthetic-secret' } });
  fireEvent.change(screen.getByLabelText('Authorization 操作'), { target: { value: 'keep' } });
  act(() => guardSettingsNavigation(guards, navigate));
  fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
  expect(navigate).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText<HTMLInputElement>('Authorization 新值').value).toBe('synthetic-secret');
  confirm.mockReturnValue(true);
  fireEvent.change(screen.getByLabelText('Authorization 操作'), { target: { value: 'replace' } });
  fireEvent.click(screen.getByRole('button', { name: '保存 MCP 配置' }));
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => finish(Response.json({ message: '合成保存失败' }, { status: 409 })));
  await screen.findByText('合成保存失败');
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).toHaveBeenCalledOnce();
});
it('列表不隐式检查连接，秘密为空白，保存冲突保留草稿和原 revision', async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({ url: input as string, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if ((input as string).includes('/session-tools/')) return Response.json(sessionStatus());
    return init?.method === 'POST'
      ? Response.json({ message: '原生文件已被其他操作修改' }, { status: 409 })
      : Response.json({ ...catalog, instances: [] });
  });
  render(<NativeMcpPanel context={{ agent: 'codex' }} reload={0} onChanged={vi.fn()} />);
  await screen.findByText('demo');
  expect(calls.filter((c) => c.url.includes('/control'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '编辑 demo' }));
  expect(screen.getByLabelText<HTMLInputElement>('Authorization 新值').value).toBe('');
  fireEvent.change(screen.getByLabelText('Authorization 操作'), { target: { value: 'replace' } });
  fireEvent.change(screen.getByLabelText('Authorization 新值'), { target: { value: 'new-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '保存 MCP 配置' }));
  await screen.findByText('原生文件已被其他操作修改');
  expect(screen.getByLabelText<HTMLInputElement>('Authorization 新值').value).toBe('new-secret');
  expect(calls.at(-1)!.body).toMatchObject({
    revision: 'original',
    config: { headers: { Authorization: { action: 'replace', value: 'new-secret' } } },
  });
});
it('选择子目录实例先保护草稿，再重读对应目录并绑定控制', async () => {
  const guards: SettingsNavigation = new Map();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const instanceId = '11111111-1111-4111-8111-111111111111';
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input as string,
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url.includes('/session-tools/')) return Response.json(sessionStatus());
    if (init?.method === 'POST')
      return Response.json({
        instanceId,
        name: 'child-only',
        state: 'connected',
        tools: [],
        canReconnect: false,
        canToggle: false,
        canLogin: false,
      });
    const selected = url.includes(`instanceId=${instanceId}`);
    return Response.json({
      ...catalog,
      instanceId: selected ? instanceId : undefined,
      instances: [{ instanceId, sessionId: 'child-session', cwd: '~/projects/demo/child' }],
      entries: [
        {
          ...catalog.entries[0],
          id: selected ? 'child-entry' : 'root-entry',
          name: selected ? 'child-only' : 'root-only',
          actions: selected
            ? { edit: false, delete: false, enable: false, disable: false }
            : catalog.entries[0]!.actions,
        },
      ],
    });
  });
  render(
    <SettingsNavigationContext value={guards}>
      <NativeMcpPanel context={{ agent: 'codex', projectId: 'demo' }} reload={0} onChanged={vi.fn()} />
    </SettingsNavigationContext>,
  );
  await screen.findByText('root-only');
  expect(screen.getByRole('option', { name: /child-session/ }).textContent).toContain('~/projects/demo/child');
  fireEvent.click(screen.getByRole('button', { name: '编辑 root-only' }));
  fireEvent.change(screen.getByLabelText('Authorization 操作'), { target: { value: 'replace' } });
  fireEvent.change(screen.getByLabelText('Authorization 新值'), { target: { value: 'synthetic-instance-draft' } });
  fireEvent.change(screen.getByRole('combobox', { name: '运行实例' }), { target: { value: instanceId } });
  expect(screen.getByLabelText<HTMLInputElement>('Authorization 新值').value).toBe('synthetic-instance-draft');
  expect(calls.some((call) => call.url.includes('instanceId='))).toBe(false);
  confirm.mockReturnValue(true);
  fireEvent.change(screen.getByRole('combobox', { name: '运行实例' }), { target: { value: instanceId } });
  await screen.findByText('child-only');
  expect(screen.queryByText('root-only')).toBeNull();
  expect(screen.queryByRole('button', { name: '编辑 child-only' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '检查 child-only 连接' }));
  await screen.findByText(/已连接/);
  expect(calls.find((call) => call.url.includes('/control'))?.body).toMatchObject({ id: 'child-entry', instanceId });
});
it('专用开关与 MCP 目录双向刷新，自有配置不重复展示且同名项目配置仍可管理', async () => {
  let enabled = true;
  const calls: string[] = [];
  const managed = { ...catalog.entries[0]!, name: 'agentdeck_sessions', managedBy: 'session-tools' };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input as string;
    calls.push(url);
    if (url.includes('/session-tools/')) {
      if (init?.method === 'PUT') enabled = JSON.parse(init.body as string).enabled;
      return Response.json(sessionStatus(enabled));
    }
    if (url.includes('/native-resources/'))
      return Response.json({ agent: 'codex', entries: [], roots: [], warnings: [], guidance: [] });
    return Response.json({
      ...catalog,
      instances: [],
      entries: [
        ...(enabled ? [managed] : []),
        { ...catalog.entries[0], id: 'project-entry', name: 'agentdeck_sessions', scope: 'project' },
      ],
    });
  });
  render(<NativeResourcesDialog agent="codex" category="mcp" embedded onClose={vi.fn()} onBack={vi.fn()} />);
  const toggle = await screen.findByRole<HTMLButtonElement>('switch', { name: '会话引用' });
  await waitFor(() => expect(toggle.disabled).toBe(false));
  await screen.findByRole('heading', { name: 'agentdeck_sessions' });
  expect(screen.getAllByRole('button', { name: '编辑 agentdeck_sessions' })).toHaveLength(1);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  await waitFor(() =>
    expect(calls.filter((url) => url === '/api/native-management/codex/mcp').length).toBeGreaterThan(1),
  );
  expect(screen.getAllByRole('heading', { name: 'agentdeck_sessions' })).toHaveLength(1);
  await waitFor(() => expect(toggle.disabled).toBe(false));
  enabled = true;
  fireEvent.click(screen.getByRole('button', { name: '刷新目录' }));
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  expect(screen.getAllByRole('button', { name: '编辑 agentdeck_sessions' })).toHaveLength(1);
});
