import { afterEach, expect, it, vi } from 'vitest';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { claudeMcpControl } from '../../../src/agents/claude/interaction/mcp-control';
import type { ClaudeQuery } from '../../../src/agents/claude/run/query';
import * as claudeQuery from '../../../src/agents/claude/run/query';
import { CodexClient } from '../../../src/agents/codex/run/client';
import { codexMcpControl } from '../../../src/agents/codex/interaction/mcp-control';
import { loginCodexMcp } from '../../../src/agents/codex/interaction/mcp-oauth';
import { checkMcpConnection } from '../../../src/native-management/mcp/mcp-check';
import type { RecordValue } from '../../../src/agents/codex/run/types';
import type { McpContext } from '../../../src/native-management/mcp/mcp-types';

afterEach(() => vi.restoreAllMocks());
const context: McpContext = { agent: 'codex', homeDir: process.cwd(), env: {} };
function fakeClient(response: (method: string, params: RecordValue) => Promise<RecordValue>) {
  let closed!: () => void;
  const client = {
    closed: new Promise<void>((resolve) => {
      closed = resolve;
    }),
    onNotification: (_method: string, _params: RecordValue) => {},
    request: vi.fn(response),
    initialize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => {
      closed();
      return Promise.resolve();
    }),
  };
  vi.spyOn(CodexClient, 'start').mockResolvedValue(client as unknown as CodexClient);
  return client;
}
function fakeClaude(statuses: McpServerStatus[][]): ClaudeQuery {
  let close!: () => void;
  const ended = new Promise<void>((resolve) => {
    close = resolve;
  });
  let index = 0;
  const query = {
    async *[Symbol.asyncIterator]() {
      await ended;
      yield {};
    },
    close: vi.fn(() => close()),
    interrupt: vi.fn(() => Promise.resolve()),
    mcpServerStatus: vi.fn(() => Promise.resolve(statuses[Math.min(index++, statuses.length - 1)]!)),
    reconnectMcpServer: vi.fn(() => Promise.resolve()),
    toggleMcpServer: vi.fn(() => Promise.resolve()),
  } as unknown as ClaudeQuery;
  vi.spyOn(claudeQuery, 'nativeClaudeQuery').mockReturnValue(query);
  return query;
}
it('Claude 控制保留五类状态、工具目录和运行启停，缺接口明确拒绝', async () => {
  const query = fakeClaude([
    [{ name: 'demo', status: 'needs-auth', error: 'secret', tools: [{ name: 'tool' }] }],
    [{ name: 'demo', status: 'disabled' }],
    [],
  ]);
  const control = claudeMcpControl(query, 'one');
  expect(await control.status('demo')).toMatchObject({
    state: 'authenticationRequired',
    auth: 'notLoggedIn',
    tools: ['tool'],
    canLogin: false,
  });
  await control.toggle!('demo', false);
  expect(query.toggleMcpServer).toHaveBeenCalledWith('demo', false);
  expect(await control.status('demo')).toMatchObject({ state: 'disabled', tools: [] });
  await control.reconnect!('demo');
  expect(query.reconnectMcpServer).toHaveBeenCalledWith('demo');
  expect(await control.status('missing')).toMatchObject({ state: 'unknown' });
  const missing = claudeMcpControl({} as ClaudeQuery, 'none');
  for (const run of [
    () => missing.status('demo'),
    () => missing.toggle!('demo', true),
    () => missing.reconnect!('demo'),
  ])
    await expect(run()).rejects.toMatchObject({ code: 'unsupported_action' });
  query.close();
});
it('Claude 显式检查仅连接选中配置、等待状态并关闭，绝不发送模型输入或准许工具', async () => {
  const query = fakeClaude([
    [{ name: 'demo', status: 'pending' }],
    [{ name: 'demo', status: 'connected', tools: [{ name: 'tool' }] }],
  ]);
  const result = await checkMcpConnection({ ...context, agent: 'claude' }, 'demo', { command: 'node' });
  expect(result).toMatchObject({ state: 'connected', canToggle: false, canReconnect: false });
  const options = vi.mocked(claudeQuery.nativeClaudeQuery).mock.calls[0]![0].options;
  expect(options).toMatchObject({
    settingSources: [],
    strictMcpConfig: true,
    settings: { disableAllHooks: true },
    mcpServers: { demo: { command: 'node' } },
  });
  expect(
    await options.onElicitation!(
      { serverName: 'demo', message: 'fixture' },
      { signal: new AbortController().signal, requestId: 'one' },
    ),
  ).toEqual({ action: 'cancel' });
  expect(
    await options.canUseTool!('tool', {}, { signal: new AbortController().signal, toolUseID: 'one', requestId: 'one' }),
  ).toMatchObject({ behavior: 'deny' });
  expect(query.close).toHaveBeenCalled();
});
it('Codex 检查失败仍关闭子进程，AGY不会创建假连接；重载使用固定原生入口', async () => {
  const client = fakeClient(async () => {
    throw new Error('secret');
  });
  await expect(checkMcpConnection(context, 'demo', {})).rejects.toThrow();
  expect(client.close).toHaveBeenCalled();
  await expect(checkMcpConnection({ ...context, agent: 'antigravity' }, 'demo', {})).rejects.toMatchObject({
    code: 'unsupported_action',
  });
  client.request.mockResolvedValue({
    data: [{ name: 'demo', authStatus: 'unsupported', runtimeStatus: 'cancelled', tools: {} }],
  });
  expect(await checkMcpConnection(context, 'demo', {})).toMatchObject({
    state: 'cancelled',
    canReconnect: false,
    canLogin: false,
  });
  await codexMcpControl(client, 'one', () => 'session').reconnect!('demo');
  expect(client.request).toHaveBeenLastCalledWith('config/mcpServer/reload', {});
});
it('Codex OAuth 严格核对 loginId、名称、线程，支持先到完成通知且不回传原生错误', async () => {
  const client = fakeClient(async () => {
    client.onNotification('unrelated', {});
    client.onNotification('mcpServer/oauthLogin/completed', { name: 'demo', loginId: 'wrong', success: true });
    client.onNotification('mcpServer/oauthLogin/completed', { name: 'other', loginId: 'login', success: true });
    client.onNotification('mcpServer/oauthLogin/completed', {
      name: 'demo',
      loginId: 'login',
      threadId: 'foreign',
      success: true,
    });
    client.onNotification('mcpServer/oauthLogin/completed', { name: 'demo', loginId: 'login', success: true });
    return { loginId: 'login', authorizationUrl: 'https://example.com/authorize' };
  });
  const authorize = vi.fn();
  await loginCodexMcp(context, 'demo', { signal: new AbortController().signal, authorize });
  expect(authorize).toHaveBeenCalledWith('https://example.com/authorize');
  expect(client.request).toHaveBeenCalledWith('mcpServer/oauth/login', { name: 'demo', timeoutSecs: 120 });
  expect(client.close).toHaveBeenCalled();
});
it('Codex OAuth 取消与原生失败关闭进程，缺 loginId 不接受不可关联的完成', async () => {
  const client = fakeClient(() =>
    Promise.resolve({ loginId: 'login', authorizationUrl: 'https://example.com/authorize' }),
  );
  await expect(
    loginCodexMcp(context, 'demo', {
      signal: new AbortController().signal,
      authorize: () => {
        client.onNotification('mcpServer/oauthLogin/completed', { name: 'demo', loginId: 'wrong', success: true });
        client.onNotification('mcpServer/oauthLogin/completed', {
          name: 'demo',
          loginId: 'login',
          success: false,
          error: 'secret',
        });
      },
    }),
  ).rejects.toThrow();
  client.request.mockResolvedValue({ authorizationUrl: 'https://example.com/authorize' });
  await expect(
    loginCodexMcp(context, 'demo', { signal: new AbortController().signal, authorize: vi.fn() }),
  ).rejects.toThrow();
  expect(client.close).toHaveBeenCalledTimes(2);
});
