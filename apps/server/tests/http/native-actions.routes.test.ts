import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app';
import { registerNativeActionRoutes } from '../../src/http/native-actions.routes';
const apps: FastifyInstance[] = [];
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: 'AGENTDECK_session=test-token' };
const base = '/api/projects/project/sessions/codex/native/native-actions';
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it('原生回退必须经过认证、同源和明确确认，参数错误不泄漏请求或诊断', async () => {
  const service = {
    catalog: vi.fn(),
    preview: vi.fn(),
    execute: vi.fn(async () => ({ status: 'completed' as const, message: '已完成' })),
  };
  const app = await buildApp({
    token: 'test-token',
    port: 4317,
    routes: (app) => registerNativeActionRoutes(app, service),
  });
  apps.push(app);
  const valid = { token: '12345678-1234-4123-8123-123456789abc', confirmed: true };
  for (const h of [
    { ...headers, cookie: '' },
    { ...headers, origin: 'https://example.com' },
  ])
    expect([401, 403]).toContain(
      (await app.inject({ method: 'POST', url: base + '/execute', headers: h, payload: valid })).statusCode,
    );
  for (const payload of [
    { ...valid, confirmed: false },
    { ...valid, path: 'sentinel-private' },
  ]) {
    const reply = await app.inject({ method: 'POST', url: base + '/execute', headers, payload });
    expect(reply.statusCode).toBe(400);
    expect(reply.body).not.toContain('sentinel-private');
  }
  expect(service.execute).not.toHaveBeenCalled();
  const reply = await app.inject({ method: 'POST', url: base + '/execute', headers, payload: valid });
  expect(reply.statusCode).toBe(200);
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(service.execute).toHaveBeenCalledWith(
    { workspaceId: 'project', agent: 'codex', sessionId: 'native' },
    valid.token,
  );
  service.execute.mockRejectedValueOnce(new Error('sentinel-private'));
  const failed = await app.inject({ method: 'POST', url: base + '/execute', headers, payload: valid });
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toContain('sentinel-private');
});
