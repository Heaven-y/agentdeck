import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeMcpService } from '../../src/native-management/mcp-service';
import { createMcpControlService } from '../../src/native-management/mcp-control-service';
import { McpRuntimeRegistry } from '../../src/native-management/mcp-runtime';
import { createNativeManagementAccess } from '../../src/native-management/access';
import { createCliActivity } from '../../src/bootstrap/cli-activity';
import { SessionError } from '../../src/agents/errors';
import { createWorkspaceActivity } from '../../src/workspaces/activity';
import * as check from '../../src/native-management/mcp-check';
import * as login from '../../src/agents/codex/mcp-oauth';
afterEach(() => vi.restoreAllMocks());

it('等待授权的回合可查询自身实例；持久写被拒绝，新检查不与安装并发', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-mcp-lock-'));
  try {
    const project = { id: 'demo', dir: path.join(root, 'project') };
    await mkdir(project.dir);
    await mkdir(path.join(root, '.codex'));
    await writeFile(path.join(root, '.codex/config.toml'), '[mcp_servers.demo]\ncommand = "node"\n');
    const native = createCliActivity(),
      withIdleAgent = vi.fn(() => {
        throw new SessionError(409, 'agent_busy', 'CLI 正忙');
      });
    const access = createNativeManagementAccess({
      native,
      withIdleAgent,
      workspace: { withIdle: (_id, operation) => operation() },
    });
    const service = createNativeMcpService({ homeDir: root, env: {}, access, plugins: async () => [] });
    const registry = new McpRuntimeRegistry();
    registry.register({
      agent: 'codex',
      projectId: project.id,
      cwd: project.dir,
      instanceId: 'live',
      sessionId: () => 'native-session',
      control: {
        status: (name) =>
          Promise.resolve({
            instanceId: 'live',
            name,
            state: 'authenticationRequired',
            auth: 'notLoggedIn',
            tools: [],
            canReconnect: true,
            canToggle: false,
            canLogin: true,
          }),
      },
    });
    const controls = createMcpControlService({
      service,
      registry,
      access,
      workspace: { acquire: createWorkspaceActivity().acquire, get: () => Promise.resolve(project) },
    });
    const entry = (await service.readMcp('codex', project)).entries[0]!;
    const input = { id: entry.id, revision: entry.revision, action: 'check' as const };
    expect(await controls.operate('codex', { ...input, instanceId: 'live' }, project)).toMatchObject({
      state: 'authenticationRequired',
    });
    expect(withIdleAgent).not.toHaveBeenCalled();
    await expect(
      service.operateMcp('codex', { id: entry.id, revision: entry.revision, action: 'disable' }, project),
    ).rejects.toMatchObject({ code: 'agent_busy' });
    await expect(native.exclusive('codex', () => controls.operate('codex', input, project))).rejects.toMatchObject({
      code: 'agent_busy',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('显式检查与授权使用读租约，运行重载启停使用窄控制且区分不支持动作', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-mcp-control-'));
  try {
    const project = { id: 'demo', dir: path.join(root, 'project') };
    await mkdir(project.dir);
    await mkdir(path.join(root, '.codex'));
    await writeFile(path.join(root, '.codex/config.toml'), '[mcp_servers.demo]\nurl = "https://example.com/mcp"\n');
    const access = createNativeManagementAccess({
      native: createCliActivity(),
      withIdleAgent: (_a, run) => run(),
      workspace: { withIdle: (_id, run) => run() },
    });
    const service = createNativeMcpService({ homeDir: root, env: {}, plugins: async () => [] });
    const registry = new McpRuntimeRegistry();
    const status = {
      instanceId: 'live',
      name: 'demo',
      state: 'connected' as const,
      auth: 'oAuth',
      tools: [],
      canReconnect: true,
      canToggle: true,
      canLogin: true,
    };
    const reconnect = vi.fn(() => Promise.resolve()),
      toggle = vi.fn(() => Promise.resolve());
    registry.register({
      agent: 'codex',
      projectId: project.id,
      cwd: project.dir,
      instanceId: 'live',
      sessionId: () => 'session',
      control: { status: () => Promise.resolve(status), reconnect, toggle },
    });
    const controls = createMcpControlService({
      service,
      registry,
      access,
      workspace: { acquire: createWorkspaceActivity().acquire, get: () => Promise.resolve(project) },
    });
    const entry = (await service.readMcp('codex')).entries[0]!,
      input = { id: entry.id, revision: entry.revision };
    vi.spyOn(check, 'checkMcpConnection').mockResolvedValue(status);
    expect(await controls.operate('codex', { ...input, action: 'check' })).toEqual(status);
    for (const action of ['reconnect', 'runtime-enable', 'runtime-disable'] as const)
      await controls.operate('codex', { ...input, instanceId: 'live', action }, project);
    expect(reconnect).toHaveBeenCalledWith('demo');
    expect(toggle.mock.calls).toEqual([
      ['demo', true],
      ['demo', false],
    ]);
    await expect(controls.operate('codex', { ...input, action: 'reconnect' })).rejects.toMatchObject({
      code: 'unsupported_action',
    });
    expect(controls.instances('codex', project)).toHaveLength(1);
    expect(controls.instances('codex')).toEqual([]);
    vi.spyOn(login, 'loginCodexMcp').mockImplementation((_context, _name, session) => {
      session.authorize('https://example.com/authorize');
      return new Promise<void>((resolve) => session.signal.addEventListener('abort', () => resolve()));
    });
    const operation = await controls.operate('codex', { ...input, instanceId: 'live', action: 'login' }, project);
    expect('id' in operation).toBe(true);
    await vi.waitFor(() => expect(controls.oauth.list('codex', project.id)[0]?.state).toBe('waiting'));
    controls.oauth.cancel('codex', project.id, controls.oauth.list('codex', project.id)[0]!.id);
    expect(controls.oauth.list('codex', project.id)).toEqual([]);
    controls.oauth.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
