// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { queryClient } from '../../../../src/lib/query-client';
import { SessionToolsPanel } from '../../../../src/features/settings/mcp/SessionToolsPanel';

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  queryClient.clear();
  vi.unstubAllGlobals();
});
it.each(['claude', 'codex', 'antigravity'] as const)('按 %s 显式启停会话引用，冲突后重读实际状态', async (agent) => {
  let enabled = false;
  let conflict = false;
  const changed = vi.fn();
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        writes.push({ url, body: JSON.parse(typeof init.body === 'string' ? init.body : '') });
        if (conflict) return Response.json({ message: '原生配置已改变，请刷新后重试。' }, { status: 409 });
        enabled = (JSON.parse(init.body as string) as { enabled: boolean }).enabled;
      }
      return Response.json({ agent, enabled, available: true, revision: 'revision-1' });
    }),
  );
  render(<SessionToolsPanel agent={agent} compact={agent === 'codex'} onChanged={changed} />);
  const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: '会话引用' });
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(writes).toEqual([]);
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(writes).toEqual([{ url: `/api/session-tools/${agent}`, body: { enabled: true, revision: 'revision-1' } }]);
  expect(changed).toHaveBeenCalledOnce();
  conflict = true;
  fireEvent.click(toggle);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '原生配置已改变，请刷新后重试。');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(changed).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  await waitFor(() => expect(toggle.disabled).toBe(false));
  conflict = false;
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
});
