import { expect, it, vi } from 'vitest';
import { McpRuntimeRegistry } from '../../src/native-management/mcp-runtime';
import { codexMcpControl } from '../../src/agents/codex/mcp-control';

it('运行控制只取得实例窄租约，实例退出使迟到结果无效', async () => {
  const registry = new McpRuntimeRegistry();
  const project = { id: 'demo', dir: process.cwd() };
  let resolve!: (value: unknown) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const remove = registry.register({
    agent: 'codex',
    projectId: 'demo',
    cwd: project.dir,
    instanceId: 'one',
    sessionId: () => 'session',
    control: {
      status: async () => {
        await pending;
        return {
          instanceId: 'one',
          name: 'demo',
          state: 'connected',
          auth: 'unknown',
          tools: [],
          canReconnect: true,
          canToggle: false,
          canLogin: true,
        };
      },
    },
  });
  const call = registry.use('codex', project, 'one', (runtime) => runtime.control.status('demo'));
  remove();
  resolve({});
  await expect(call).rejects.toMatchObject({ code: 'native_unavailable' });
  expect(registry.list('codex', project)).toEqual([]);
});
it('Codex 保留原生分页与认证状态，不把未启动标记成失败，也不透传秘密诊断', async () => {
  const request = vi.fn(async () => ({
    data: [
      {
        name: 'demo',
        runtimeStatus: 'notStarted',
        authStatus: 'notLoggedIn',
        tools: { safe_tool: {} },
        error: 'sentinel-secret',
      },
    ],
    nextCursor: 'next',
  }));
  const control = codexMcpControl({ request }, 'one', () => 'session');
  const result = await control.status('demo', 'previous');
  expect(request).toHaveBeenCalledWith('mcpServerStatus/list', {
    threadId: 'session',
    serverName: 'demo',
    detail: 'toolsAndAuthOnly',
    cursor: 'previous',
    limit: 20,
  });
  expect(result).toMatchObject({ state: 'notStarted', auth: 'notLoggedIn', nextCursor: 'next', tools: ['safe_tool'] });
  expect(JSON.stringify(result)).not.toContain('sentinel-secret');
});
it('Codex 无线程检查的工具发现失败保留安全失败类别', async () => {
  const request = vi.fn(async () => ({
    data: [{ name: 'demo', runtimeStatus: null, authStatus: 'unknown', tools: {}, toolsError: 'sentinel-secret' }],
  }));
  const status = await codexMcpControl({ request }, 'one', () => undefined).status('demo');
  expect(status.state).toBe('failed');
  expect(JSON.stringify(status)).not.toContain('sentinel-secret');
});
