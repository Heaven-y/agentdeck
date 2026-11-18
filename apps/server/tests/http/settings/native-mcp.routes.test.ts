import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/http/app';
import { registerNativeMcpRoutes } from '../../../src/http/settings/native-mcp.routes';
import { createNativeMcpService } from '../../../src/native-management/mcp/mcp-service';
import { createMcpControlService } from '../../../src/native-management/mcp/mcp-control-service';
import { McpRuntimeRegistry } from '../../../src/native-management/mcp/mcp-runtime';
import { createWorkspaceActivity } from '../../../src/workspaces/activity';
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
