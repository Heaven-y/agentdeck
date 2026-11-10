// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NativeMcpPanel from '../../../src/features/settings/NativeMcpPanel';
import type { NativeMcpCatalog } from '@agentdeck/shared/settings';
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('列表不隐式检查连接，秘密为空白，保存冲突保留草稿和原 revision', async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({ url: input as string, body: init?.body ? JSON.parse(init.body as string) : undefined });
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
