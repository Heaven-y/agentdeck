import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeMcpService } from '../../src/native-management/mcp-service';
import { createMcpControlService } from '../../src/native-management/mcp-control-service';
import { McpRuntimeRegistry } from '../../src/native-management/mcp-runtime';
import { createWorkspaceActivity } from '../../src/workspaces/activity';
import { mcpPluginsFromRecords } from '../../src/native-management/mcp-plugins';
import * as check from '../../src/native-management/mcp-check';
import * as login from '../../src/agents/codex/mcp-oauth';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-mcp-identities-'));
  dirs.push(homeDir);
  const a = { id: 'project', dir: path.join(homeDir, 'a') },
    b = { id: 'project', dir: path.join(homeDir, 'b') };
  for (const project of [a, b]) {
    await mkdir(project.dir);
    await writeFile(path.join(project.dir, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'node' } } }));
  }
  await mkdir(path.join(homeDir, '.codex'));
  await writeFile(path.join(homeDir, '.codex/config.toml'), '[mcp_servers.demo]\nurl = "https://example.com/mcp"\n');
  let current = a;
  const activity = createWorkspaceActivity(),
    registry = new McpRuntimeRegistry();
  const workspace = { acquire: activity.acquire, get: (_id: string) => Promise.resolve(current) };
  const service = createNativeMcpService({ homeDir, env: {}, plugins: async () => [] });
  const controls = createMcpControlService({
    service,
    registry,
    workspace,
    access: { read: (_a, run) => run(), write: (_a, _p, run) => run() },
  });
  const change = (project: typeof a) =>
    activity.withIdle(project.id, () => {
      current = project;
      return Promise.resolve();
    });
  const status = {
    instanceId: 'old-instance',
    name: 'demo',
    state: 'connected' as const,
    auth: 'unknown',
    tools: [],
    canReconnect: true,
    canToggle: true,
    canLogin: true,
  };
  return { homeDir, a, b, service, controls, registry, activity, workspace, change, status };
}
it('项目ID不变但目录改变后，旧实例不被列出且直接控制与OAuth均拒绝', async () => {
  const f = await fixture();
  const toggle = vi.fn(() => Promise.resolve());
  for (const agent of ['claude', 'codex'] as const)
    f.registry.register({
      agent,
      projectId: f.a.id,
      cwd: f.a.dir,
      instanceId: `${agent}-old`,
      sessionId: () => 'old-session',
      control: { status: () => Promise.resolve(f.status), toggle },
    });
  await f.change(f.b);
  for (const agent of ['claude', 'codex'] as const) {
    const entry = (await f.service.readMcp(agent, f.b)).entries[0]!;
    expect(f.controls.instances(agent, f.b)).toEqual([]);
    await expect(
      f.controls.operate(
        agent,
        {
          id: entry.id,
          revision: entry.revision,
          instanceId: `${agent}-old`,
          action: agent === 'claude' ? 'runtime-disable' : 'login',
        },
        f.b,
      ),
    ).rejects.toMatchObject({ code: 'native_unavailable' });
  }
  expect(toggle).not.toHaveBeenCalled();
});
it('实例控制持有项目活动租约直到完成，换目录先赢时旧上下文被拒绝', async () => {
  const f = await fixture();
  let complete!: () => void;
  const toggle = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  f.registry.register({
    agent: 'claude',
    projectId: f.a.id,
    cwd: f.a.dir,
    instanceId: 'old-instance',
    sessionId: () => 'session',
    control: { status: () => Promise.resolve(f.status), toggle },
  });
  const entry = (await f.service.readMcp('claude', f.a)).entries[0]!,
    input = { id: entry.id, revision: entry.revision, instanceId: 'old-instance', action: 'runtime-disable' as const };
  const pending = f.controls.operate('claude', input, f.a);
  await vi.waitFor(() => expect(toggle).toHaveBeenCalled());
  await expect(f.change(f.b)).rejects.toMatchObject({ name: 'Error' });
  complete();
  await pending;
  await f.change(f.b);
  await expect(f.controls.operate('claude', input, f.a)).rejects.toMatchObject({ code: 'native_unavailable' });
  expect(toggle).toHaveBeenCalledTimes(1);
});
it('单次检查和后台OAuth保持项目目录稳定，授权取消后释放项目租约', async () => {
  const f = await fixture();
  let complete!: () => void;
  const nativeCheck = vi.spyOn(check, 'checkMcpConnection').mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = () => resolve(f.status);
      }),
  );
  const entry = (await f.service.readMcp('codex', f.a)).entries[0]!,
    input = { id: entry.id, revision: entry.revision };
  const pending = f.controls.operate('codex', { ...input, action: 'check' }, f.a);
  await vi.waitFor(() => expect(nativeCheck).toHaveBeenCalled());
  await expect(f.change(f.b)).rejects.toThrow();
  complete();
  await pending;
  vi.spyOn(login, 'loginCodexMcp').mockImplementation((_context, _name, session) => {
    session.authorize('https://example.com/authorize');
    return new Promise<void>((resolve) => session.signal.addEventListener('abort', () => resolve()));
  });
  const operation = await f.controls.operate('codex', { ...input, action: 'login' }, f.a);
  if (!('id' in operation)) throw new Error('缺少授权操作');
  await vi.waitFor(() => expect(f.controls.oauth.get('codex', f.a.id, operation.id).state).toBe('waiting'));
  await expect(f.change(f.b)).rejects.toThrow();
  f.controls.oauth.cancel('codex', f.a.id, operation.id);
  await vi.waitFor(() => expect(f.change(f.b)).resolves.toBeUndefined());
});
it('同插件同名MCP按原生scope和安装根独立，重新排序身份稳定且不泄露路径', async () => {
  const f = await fixture();
  const roots = [path.join(f.homeDir, 'private-install-one'), path.join(f.homeDir, 'private-install-two')];
  for (const root of roots) {
    await mkdir(root);
    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'node' } } }));
  }
  let records = [
    { id: 'fixture@marketplace', installPath: roots[0], scope: 'user' },
    { id: 'fixture@marketplace', installPath: roots[0], scope: 'project' },
    { id: 'fixture@marketplace', installPath: roots[1], scope: 'project' },
  ];
  const service = createNativeMcpService({
    homeDir: f.homeDir,
    env: {},
    plugins: (context) => mcpPluginsFromRecords(context, records),
  });
  const before = (await service.readMcp('claude')).entries;
  expect(new Set(before.map((entry) => entry.id)).size).toBe(3);
  expect(new Set(before.map((entry) => entry.sourceId)).size).toBe(3);
  expect(new Set(before.map((entry) => entry.revision)).size).toBe(3);
  expect(JSON.stringify(before)).not.toContain('private-install');
  records = records.toReversed();
  expect((await service.readMcp('claude')).entries.map((entry) => entry.id).sort()).toEqual(
    before.map((entry) => entry.id).sort(),
  );
});
