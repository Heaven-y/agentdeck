import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/http/app';
import { registerNativeMcpRoutes } from '../../../src/http/settings/native-mcp.routes';
import { createNativeMcpService } from '../../../src/native-management/mcp/mcp-service';
import { createMcpControlService } from '../../../src/native-management/mcp/mcp-control-service';
import { McpRuntimeRegistry } from '../../../src/native-management/mcp/mcp-runtime';
import { createWorkspaceActivity, WorkspaceBusyError } from '../../../src/workspaces/activity';
import { createNativeManagementAccess } from '../../../src/native-management/access';
import { createCliActivity } from '../../../src/bootstrap/cli-activity';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
it('MCP GET 不做运行控制，写操作保持鉴权、Origin、严格schema与no-store', async () => {
  const service = createNativeMcpService();
  vi.spyOn(service, 'readMcp').mockResolvedValue({ agent: 'claude', entries: [], sources: [], warnings: [] });
  const controls = createMcpControlService({
    service,
    registry: new McpRuntimeRegistry(),
    workspace: { acquire: createWorkspaceActivity().acquire, get: () => Promise.resolve(undefined) },
    access: { read: async (_a, run) => run(), write: async (_a, _p, run) => run() },
  });
  const control = vi.spyOn(controls, 'operate');
  const save = vi.spyOn(service, 'saveMcp');
  const app = await buildApp({
    token: 'test-token',
    port: 4317,
    routes: (app) => registerNativeMcpRoutes(app, { service, controls, store: { get: async () => undefined } }),
  });
  apps.push(app);
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: 'AGENTDECK_session=test-token' };
  const base = '/api/native-management/claude/mcp';
  const read = await app.inject({ url: base, headers });
  expect(read.statusCode).toBe(200);
  expect(read.headers['cache-control']).toBe('no-store');
  expect(control).not.toHaveBeenCalled();
  const payload = {
    sourceId: 'a'.repeat(64),
    revision: 'b'.repeat(64),
    name: 'demo',
    config: { transport: 'stdio', command: 'node' },
  };
  for (const h of [
    { ...headers, cookie: '' },
    { ...headers, origin: 'https://example.com' },
  ])
    expect([401, 403]).toContain(
      (await app.inject({ method: 'POST', url: base + '/save', headers: h, payload })).statusCode,
    );
  for (const body of [
    { ...payload, path: 'private-sentinel' },
    { ...payload, config: { ...payload.config, env: { TOKEN: 'private-sentinel' } } },
  ]) {
    const result = await app.inject({ method: 'POST', url: base + '/save', headers, payload: body });
    expect(result.statusCode).toBe(400);
    expect(result.body).not.toContain('private-sentinel');
    expect(result.headers['cache-control']).toBe('no-store');
  }
  expect(save).not.toHaveBeenCalled();
});
it('所选实例 GET 按实际目录列配置，写请求不能借 instanceId 改写目录', async () => {
  const project = { id: 'demo', name: '合成项目', dir: path.join(os.tmpdir(), 'mcp-http-project') };
  const cwd = path.join(project.dir, 'child'),
    instanceId = '11111111-1111-4111-8111-111111111111';
  const service = createNativeMcpService();
  const read = vi
    .spyOn(service, 'readMcp')
    .mockResolvedValue({ agent: 'codex', entries: [], sources: [], warnings: [] });
  const registry = new McpRuntimeRegistry();
  registry.register({
    agent: 'codex',
    projectId: project.id,
    projectDir: project.dir,
    cwd,
    instanceId,
    sessionId: () => 'child-session',
    control: { status: vi.fn() },
  });
  const controls = createMcpControlService({
    service,
    registry,
    workspace: { acquire: createWorkspaceActivity().acquire, get: async () => project },
    access: { read: async (_a, run) => run(), write: async (_a, _p, run) => run() },
  });
  const app = await buildApp({
    token: 'test-token',
    port: 4317,
    routes: (app) => registerNativeMcpRoutes(app, { service, controls, store: { get: async () => project } }),
  });
  apps.push(app);
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: 'AGENTDECK_session=test-token' };
  const base = `/api/native-management/codex/mcp?projectId=demo&instanceId=${instanceId}`;
  const response = await app.inject({ url: base, headers });
  expect(response.statusCode).toBe(200);
  expect(read).toHaveBeenCalledWith('codex', { ...project, dir: cwd });
  expect(response.json()).toMatchObject({ instanceId, instances: [{ instanceId, cwd, sessionId: 'child-session' }] });
  const rejected = await app.inject({ method: 'POST', url: base.replace('/mcp?', '/mcp/save?'), headers, payload: {} });
  expect(rejected.statusCode).toBe(400);
});

it.each([
  { endpoint: 'save', reason: '换目录', status: 409, code: 'revision_conflict' },
  { endpoint: 'change', reason: '换目录', status: 409, code: 'revision_conflict' },
  { endpoint: 'change', reason: '移除项目', status: 404, code: 'project_missing' },
])('MCP $endpoint 在租约内复核项目：$reason 后不写任何目录', async ({ endpoint, reason, status, code }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-http-lease-'));
  const original = { id: 'demo', name: '合成项目', dir: path.join(root, 'old') };
  const replacement = { ...original, dir: path.join(root, 'new') };
  const oldFile = path.join(original.dir, '.mcp.json');
  const newFile = path.join(replacement.dir, '.mcp.json');
  await mkdir(original.dir);
  await mkdir(replacement.dir);
  try {
    const content = JSON.stringify({ mcpServers: { demo: { command: 'node' } } });
    await writeFile(oldFile, content);
    await writeFile(newFile, content);
    let current: typeof original | undefined = original;
    const workspace = createWorkspaceActivity();
    const store = {
      get: async () => {
        if (current !== original) expect(() => workspace.acquire(original.id)()).toThrow(WorkspaceBusyError);
        return current;
      },
    };
    const access = createNativeManagementAccess({
      native: createCliActivity(),
      workspace,
      withIdleAgent: async (_agent, operation) => {
        // 路由已读取旧目录，项目写租约尚未取得：此时换目录或移除先赢。
        await workspace.withIdle(original.id, async () => {
          current = reason === '换目录' ? replacement : undefined;
        });
        return operation();
      },
    });
    const onChanged = vi.fn();
    const service = createNativeMcpService({
      access,
      homeDir: root,
      env: { ProgramFiles: root },
      plugins: async () => [],
      onChanged,
    });
    const controls = createMcpControlService({
      service,
      access,
      registry: new McpRuntimeRegistry(),
      workspace: { acquire: workspace.acquire, get: store.get },
    });
    const entry = (await service.readMcp('claude', original)).entries[0]!;
    const payload =
      endpoint === 'save'
        ? {
            id: entry.id,
            sourceId: entry.sourceId,
            revision: entry.revision,
            name: entry.name,
            config: { transport: 'stdio', command: 'new-node' },
          }
        : { id: entry.id, revision: entry.revision, action: 'delete' };
    const app = await buildApp({
      token: 'test-token',
      port: 4317,
      routes: (app) => registerNativeMcpRoutes(app, { service, controls, store }),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/native-management/claude/mcp/' + endpoint + '?projectId=demo',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: 'AGENTDECK_session=test-token' },
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expect(await readFile(oldFile, 'utf8')).toBe(content);
    expect(await readFile(newFile, 'utf8')).toBe(content);
    expect(onChanged).not.toHaveBeenCalled();
  } finally {
    await rm(oldFile, { force: true });
    await rm(newFile, { force: true });
    await rmdir(original.dir);
    await rmdir(replacement.dir);
    await rmdir(root);
  }
});
