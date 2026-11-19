import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeMcpService } from '../../../src/native-management/mcp/mcp-service';
import { createMcpControlService } from '../../../src/native-management/mcp/mcp-control-service';
import { McpRuntimeRegistry } from '../../../src/native-management/mcp/mcp-runtime';
import { createWorkspaceActivity } from '../../../src/workspaces/activity';
import { mcpPluginsFromRecords } from '../../../src/native-management/mcp/mcp-plugins';
import * as check from '../../../src/native-management/mcp/mcp-check';
import * as login from '../../../src/agents/codex/interaction/mcp-oauth';

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
it.each(['check', 'login'] as const)('Codex 未知配置不启动独立 %s', async (action) => {
  const f = await fixture();
  await writeFile(path.join(f.homeDir, '.codex/config.toml'), '[mcp_servers.empty]\n');
  const probe = vi.spyOn(check, 'checkMcpConnection').mockResolvedValue(f.status);
  const authorize = vi.spyOn(login, 'loginCodexMcp').mockResolvedValue(undefined);
  const [entry] = (await f.service.readMcp('codex')).entries;
  expect(entry?.transport).toBe('unknown');
  await expect(f.controls.operate('codex', { id: entry!.id, revision: entry!.revision, action })).rejects.toMatchObject(
    { code: 'unsupported_action' },
  );
  expect(probe).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
});
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
it('子目录实例保留项目根身份，配置列表与控制均使用实际 cwd 且拒绝根目录同名配置', async () => {
  const f = await fixture();
  const child = { ...f.a, dir: path.join(f.a.dir, 'child') };
  await mkdir(path.join(child.dir, '.codex'), { recursive: true });
  await mkdir(path.join(f.a.dir, '.codex'));
  await writeFile(path.join(f.a.dir, '.codex/config.toml'), '[mcp_servers.scoped]\ncommand = "root-command"\n');
  await writeFile(path.join(child.dir, '.codex/config.toml'), '[mcp_servers.scoped]\ncommand = "child-command"\n');
  const toggle = vi.fn(async () => {});
  f.registry.register({
    agent: 'codex',
    projectId: f.a.id,
    projectDir: f.a.dir,
    cwd: child.dir,
    instanceId: 'child-instance',
    sessionId: () => 'child-session',
    control: { status: async (name) => ({ ...f.status, name }), toggle },
  });
  expect(f.controls.instances('codex', f.a)).toEqual([
    { instanceId: 'child-instance', sessionId: 'child-session', cwd: child.dir },
  ]);
  const catalog = await f.controls.catalog('codex', f.a, 'child-instance');
  const scoped = catalog.entries.find((entry) => entry.name === 'scoped')!;
  expect(scoped.config.command).toBe('child-command');
  expect(catalog.entries.every((entry) => !entry.actions.edit && !entry.actions.delete)).toBe(true);
  const rootEntry = (await f.service.readMcp('codex', f.a)).entries.find((entry) => entry.name === 'scoped')!;
  await expect(
    f.controls.operate('codex', { ...rootEntry, instanceId: 'child-instance', action: 'runtime-disable' }, f.a),
  ).rejects.toMatchObject({ code: 'native_unavailable' });
  expect(toggle).not.toHaveBeenCalled();
  await f.controls.operate('codex', { ...scoped, instanceId: 'child-instance', action: 'runtime-disable' }, f.a);
  expect(toggle).toHaveBeenCalledExactlyOnceWith('scoped', false);
  await writeFile(path.join(child.dir, '.codex/config.toml'), '[mcp_servers.demo]\ncommand = "shadow-user-command"\n');
  const userEntry = (await f.service.readMcp('codex', f.a)).entries.find((entry) => entry.name === 'demo')!;
  await expect(
    f.controls.operate('codex', { ...userEntry, instanceId: 'child-instance', action: 'runtime-disable' }, f.a),
  ).rejects.toMatchObject({ code: 'native_unavailable' });
  expect(toggle).toHaveBeenCalledTimes(1);
  await expect(f.controls.catalog('codex', { ...child, id: 'other' }, 'child-instance')).rejects.toMatchObject({
    code: 'native_unavailable',
  });
  // 换到旧根的父目录仍须拒绝，不能仅靠 cwd 前缀接受旧实例。
  const parent = { ...f.a, dir: f.homeDir };
  await f.change(parent);
  expect(f.controls.instances('codex', parent)).toEqual([]);
  await expect(f.controls.catalog('codex', parent, 'child-instance')).rejects.toMatchObject({
    code: 'native_unavailable',
  });
});
it('子目录实例授权使用实际目录，错误项目身份及越界 cwd 不能注册或控制', async () => {
  const f = await fixture();
  const child = { ...f.a, dir: path.join(f.a.dir, 'child') };
  await mkdir(path.join(child.dir, '.codex'), { recursive: true });
  await writeFile(
    path.join(child.dir, '.codex/config.toml'),
    '[mcp_servers.remote]\nurl = "https://example.com/child"\n',
  );
  const runtime = {
    agent: 'codex' as const,
    projectId: f.a.id,
    projectDir: f.a.dir,
    cwd: child.dir,
    instanceId: 'child-instance',
    sessionId: () => 'child-session',
    control: { status: async () => f.status },
  };
  expect(() => f.registry.register({ ...runtime, cwd: `${f.a.dir}-sibling` })).toThrow();
  f.registry.register(runtime);
  const nativeLogin = vi.spyOn(login, 'loginCodexMcp').mockImplementation((_context, _name, session) => {
    session.authorize('https://example.com/authorize');
    return new Promise<void>((resolve) => session.signal.addEventListener('abort', () => resolve()));
  });
  const entry = (await f.controls.catalog('codex', f.a, runtime.instanceId)).entries.find(
    (entry) => entry.name === 'remote',
  )!;
  const operation = await f.controls.operate(
    'codex',
    { ...entry, instanceId: runtime.instanceId, action: 'login' },
    f.a,
  );
  if (!('id' in operation)) throw new Error('缺少授权操作');
  await vi.waitFor(() => expect(nativeLogin).toHaveBeenCalled());
  expect(nativeLogin.mock.calls[0]?.[0].project).toEqual(child);
  await expect(f.change(f.b)).rejects.toThrow();
  f.controls.oauth.cancel('codex', f.a.id, operation.id);
  await vi.waitFor(() => expect(f.change(f.b)).resolves.toBeUndefined());
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
