// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useOfficialUsage } from '../../../../src/features/chat/models/OfficialUsageDialog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('关闭重开及另一会话共用上次结果，刷新期间保留，切换账号连接不沿用', async () => {
  const report = { checkedAt: 1000, groups: [] };
  let finish!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(report))
    .mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, rerender } = renderHook(({ scope }) => useOfficialUsage(scope, '/usage'), {
    initialProps: { scope: 'antigravity:0' },
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  act(() => result.current.read());
  await waitFor(() => expect(result.current.view?.report).toEqual(report));
  act(() => result.current.close());
  act(() => result.current.read());
  expect(result.current.view?.report).toEqual(report);
  expect(fetch).toHaveBeenCalledTimes(1);
  act(() => result.current.read());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(result.current.view?.report).toEqual(report);
  finish(Response.json({ ...report, checkedAt: 2000 }));
  await waitFor(() => expect(result.current.view?.report?.checkedAt).toBe(2000));
  rerender({ scope: 'antigravity:1' });
  expect(result.current.view).toBeUndefined();
  act(() => result.current.read());
  expect(result.current.view?.report).toBeUndefined();
  act(() => result.current.close());
  client.clear();
});
