import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/http/app';
import { registerNativePluginRoutes } from '../../../src/http/settings/native-plugins.routes';
import { createNativePluginService } from '../../../src/native-management/plugins/plugin-service';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
it('插件路由要求鉴权和 Origin，严格拒绝任意命令参数且不泄露输入', async () => {
  const service = createNativePluginService();
  vi.spyOn(service, 'read').mockResolvedValue({
    agent: 'claude',
    revision: 'a'.repeat(64),
    entries: [],
    marketplaces: [],
    operations: [],
    installScopes: ['user'],
    canAddMarketplace: true,
    warnings: [],
  });
  const prepare = vi.spyOn(service, 'prepare');
  const app = await buildApp({
    token: 'test-token',
    port: 4317,
    routes: (app) => registerNativePluginRoutes(app, { service, store: { get: async () => undefined } }),
  });
  apps.push(app);
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: 'AGENTDECK_session=test-token' },
    base = '/api/native-management/claude/plugins';
  const read = await app.inject({ url: base, headers });
  expect(read.statusCode).toBe(200);
  expect(read.headers['cache-control']).toBe('no-store');
  const payload = { action: 'install', source: 'demo@fixture', revision: 'a'.repeat(64), scope: 'user' };
  for (const h of [
    { ...headers, cookie: '' },
    { ...headers, origin: 'https://example.com' },
  ])
    expect([401, 403]).toContain(
      (await app.inject({ method: 'POST', url: base + '/prepare', headers: h, payload })).statusCode,
    );
  const bad = await app.inject({
    method: 'POST',
    url: base + '/prepare',
    headers,
    payload: { ...payload, command: 'private-sentinel' },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.body).not.toContain('private-sentinel');
  expect(prepare).not.toHaveBeenCalled();
});
