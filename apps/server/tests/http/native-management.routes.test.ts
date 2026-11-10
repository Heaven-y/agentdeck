import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app';
import { registerNativeManagementRoutes } from '../../src/http/native-management.routes';
const apps: FastifyInstance[] = [];
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: 'AGENTDECK_session=test-token' };
const base = '/api/native-management/claude/skills';
async function fixture() {
  const service = {
    readSkills: vi.fn(async () => ({ agent: 'claude' as const, entries: [], roots: [], warnings: [] })),
    changeSkill: vi.fn(async () => ({ status: 'saved' as const, nextTurn: true as const })),
    importSkill: vi.fn(async () => ({ status: 'saved' as const, nextTurn: true as const })),
  };
  const app = await buildApp({
    token: 'test-token',
    port: 4317,
    routes: (app) => registerNativeManagementRoutes(app, { service, store: { get: async () => undefined } }),
  });
  apps.push(app);
  return { service, app };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it('未授权与跨站不能修改原生技能，GET不调用任何写入', async () => {
  const { app, service } = await fixture();
  const result = await app.inject({ url: base, headers });
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  const payload = { id: 'a'.repeat(64), revision: 'b'.repeat(64), action: 'delete', confirmation: 'demo' };
  for (const h of [
    { ...headers, cookie: '' },
    { ...headers, origin: 'https://example.com' },
  ])
    expect([401, 403]).toContain(
      (await app.inject({ method: 'POST', url: base + '/change', headers: h, payload })).statusCode,
    );
  expect(service.changeSkill).not.toHaveBeenCalled();
  expect(service.importSkill).not.toHaveBeenCalled();
});
it('拒绝任意路径、跨项目资源和未知字段，错误不回显敏感请求原文', async () => {
  const { app, service } = await fixture();
  for (const payload of [
    {
      id: 'a'.repeat(64),
      revision: 'b'.repeat(64),
      action: 'state',
      value: 'off',
      scope: 'local',
      path: 'sentinel-private',
    },
    { id: '../outside', revision: 'b'.repeat(64), action: 'delete' },
  ]) {
    const result = await app.inject({ method: 'POST', url: base + '/change', headers, payload });
    expect(result.statusCode).toBe(400);
    expect(result.body).not.toContain('sentinel-private');
  }
  expect((await app.inject({ url: base + '?projectId=missing', headers })).statusCode).toBe(404);
  const malformed = await app.inject({
    method: 'POST',
    url: base + '/change',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: '{"sentinel-private"',
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toContain('sentinel-private');
  expect(malformed.headers['cache-control']).toBe('no-store');
  expect(service.changeSkill).not.toHaveBeenCalled();
});
