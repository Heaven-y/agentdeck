import { expect, it, vi } from 'vitest';
import { McpOAuthOperations, type McpOAuthSession } from '../../src/native-management/mcp-oauth';
it('OAuth 不把打开链接当完成，取消后原生迟到成功无效且不泄露回调', async () => {
  const operations = new McpOAuthOperations();
  let done!: () => void;
  let stopped = false;
  const result = operations.start(
    { agent: 'codex', projectId: 'demo', name: 'demo', instanceId: 'runtime' },
    async (session) => {
      session.signal.addEventListener('abort', () => {
        stopped = true;
        done();
      });
      session.authorize('https://example.com/oauth?state=opaque');
      await new Promise<void>((resolve) => {
        done = resolve;
      });
    },
  );
  await Promise.resolve();
  expect(operations.get('codex', 'demo', result.id).state).toBe('waiting');
  operations.cancel('codex', 'demo', result.id);
  await Promise.resolve();
  expect(stopped).toBe(true);
  expect(operations.get('codex', 'demo', result.id).state).toBe('cancelled');
  expect(operations.get('codex', 'demo', result.id).authorizationUrl).toBeUndefined();
  expect(() => operations.get('claude', 'demo', result.id)).toThrow();
});
it('重复授权请求只启动一次，实例销毁同步取消', async () => {
  const operations = new McpOAuthOperations();
  const lifetime = new AbortController();
  const run = vi.fn(
    async (session: McpOAuthSession) =>
      new Promise<void>((resolve) => session.signal.addEventListener('abort', () => resolve())),
  );
  const key = { agent: 'claude' as const, projectId: 'demo', name: 'demo', instanceId: 'runtime' };
  const first = operations.start(key, run, lifetime.signal);
  expect(operations.start(key, run, lifetime.signal).id).toBe(first.id);
  lifetime.abort();
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(1);
  expect(operations.get('claude', 'demo', first.id).state).toBe('cancelled');
});
