import { afterEach, expect, it, vi } from 'vitest';
import { sessionsApi, sessionsKeys } from '../../../src/features/sessions/api';
import { respond } from '../../fixtures/http';
afterEach(() => vi.unstubAllGlobals());
it('会话请求和缓存按 Agent 隔离，历史读取传递取消信号', async () => {
  respond(200, []);
  await sessionsApi.sessionEvents('w/1', 's 1', 'claude');
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/projects/w%2F1/sessions/claude/s%201');
  await sessionsApi.page({ agent: 'codex', scope: 'active', projectId: 'w/1' });
  expect(vi.mocked(fetch).mock.calls[1]).toEqual([
    '/api/sessions/page?agent=codex&scope=active&projectId=w%2F1',
    expect.objectContaining({ cache: 'no-store' }),
  ]);
  const controller = new AbortController();
  await sessionsApi.sessionEvents('w/1', 's 1', 'codex', controller.signal);
  expect(vi.mocked(fetch).mock.calls[2]).toEqual([
    '/api/projects/w%2F1/sessions/codex/s%201/history-page',
    expect.objectContaining({ cache: 'no-store', signal: controller.signal }),
  ]);
  expect(sessionsKeys.pages('claude', 'active', '', 'w/1')).not.toEqual(
    sessionsKeys.pages('codex', 'active', '', 'w/1'),
  );
});
it('归档查询独立缓存，管理 POST 保留确认且不绑定取消信号', async () => {
  respond(200, []);
  await sessionsApi.page({ agent: 'claude', scope: 'active', projectId: 'w/1' });
  await sessionsApi.page({ agent: 'codex', scope: 'archived', projectId: 'w/1' });
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    '/api/sessions/page?agent=claude&scope=active&projectId=w%2F1',
    '/api/sessions/page?agent=codex&scope=archived&projectId=w%2F1',
  ]);
  expect(sessionsKeys.pages('codex', 'active', '', 'w/1')).toEqual(['sessions', 'pages', 'codex', 'active', '', 'w/1']);
  expect(sessionsKeys.pages('codex', 'archived', '', 'w/1')).toEqual([
    'sessions',
    'pages',
    'codex',
    'archived',
    '',
    'w/1',
  ]);

  respond(204);
  await expect(
    sessionsApi.sessionAction('w/1', 's 1', 'codex', { action: 'delete', confirmed: true }),
  ).resolves.toBeUndefined();
  const [url, init] = vi.mocked(fetch).mock.calls[0]!;
  expect(url).toBe('/api/projects/w%2F1/sessions/codex/s%201/actions');
  expect(init).toMatchObject({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'delete', confirmed: true }),
  });
  expect(init).not.toHaveProperty('signal');
});
