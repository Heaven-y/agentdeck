import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app';
import { registerNativeMcpRoutes } from '../../src/http/native-mcp.routes';
import { createNativeMcpService } from '../../src/native-management/mcp-service';
import { createMcpControlService } from '../../src/native-management/mcp-control-service';
import { McpRuntimeRegistry } from '../../src/native-management/mcp-runtime';
import { createWorkspaceActivity } from '../../src/workspaces/activity';
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
