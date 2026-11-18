import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeResourcesService } from '../../../src/settings/resources/native-resources';
import { createModelSettingsService } from '../../../src/settings/model-settings';
import { createLaunchEnvironment } from '../../../src/settings/launch-environment';
import { registerModelSettingsRoutes } from '../../../src/http/settings/model-settings.routes';
import { SessionError } from '../../../src/agents/errors';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'model-settings-access-'));
  roots.push(homeDir);
  const environment = createLaunchEnvironment({
    configDir: path.join(homeDir, 'workbench'),
    env: {},
    protector: {
      available: true,
      protect: async (value) => Buffer.from(value.toString('hex')),
      unprotect: async (value) => Buffer.from(value.toString(), 'hex'),
    },
  });
  const file = path.join(homeDir, '.gemini/antigravity-cli/settings.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"model":"old","modelProvider":"gemini"}');
  return { homeDir, environment, file };
}
it('模型保存的CLI忙碌按409原样返回，不误报磁盘故障', async () => {
  const { homeDir } = await fixture();
  const resources = createNativeResourcesService({
    homeDir,
    env: {},
    withWrite: async () => {
      throw new SessionError(409, 'agent_busy', 'CLI 正在运行，请结束后重试');
    },
  });
  const service = createModelSettingsService({ resources });
  const initial = await service.read('claude');
  const app = Fastify();
  registerModelSettingsRoutes(app, service);
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/models/claude',
      payload: { revision: initial.revision, changes: { model: 'new' } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'agent_busy', message: 'CLI 正在运行，请结束后重试' });
  } finally {
    await app.close();
  }
});
it('AGY只修改Key也先取维护锁，忙碌时不写连接环境', async () => {
  const { homeDir, environment } = await fixture();
  const resources = createNativeResourcesService({
    homeDir,
    env: {},
    withWrite: async () => {
      throw new SessionError(409, 'agent_busy', 'CLI 正在运行');
    },
  });
  const service = createModelSettingsService({ resources, environment });
  const initial = await service.read('antigravity');
  await expect(
    service.save('antigravity', { revision: initial.revision, changes: { apiKey: 'fixture-key' } }),
  ).rejects.toMatchObject({ code: 'agent_busy' });
  expect((await environment.resolve('antigravity')).GEMINI_API_KEY).toBeUndefined();
});
it.each([false, true])('AGY连接与原生配置在同一维护租约保存并只失效一次（含原生更改=%s）', async (changeNative) => {
  const { homeDir, environment } = await fixture();
  let locked = false,
    calls = 0,
    changed = 0;
  const resources = createNativeResourcesService({
    homeDir,
    env: {},
    withWrite: async (_agent, _project, operation) => {
      expect(locked).toBe(false);
      locked = true;
      calls++;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    },
    onSaved: () => {
      expect(locked).toBe(true);
      changed++;
    },
  });
  const original = environment.save;
  vi.spyOn(environment, 'save').mockImplementation(async (...args) => {
    expect(locked).toBe(true);
    return original(...args);
  });
  const service = createModelSettingsService({ resources, environment });
  const initial = await service.read('antigravity');
  await service.save('antigravity', {
    revision: initial.revision,
    changes: { apiKey: 'fixture-key', ...(changeNative ? { model: 'new' } : {}) },
  });
  expect({ calls, changed, locked }).toEqual({ calls: 1, changed: 1, locked: false });
  expect((await environment.resolve('antigravity')).GEMINI_API_KEY).toBe('fixture-key');
});
it('连接保存后原生冲突的回滚及失效仍在同一维护租约内', async () => {
  const { homeDir, environment, file } = await fixture();
  let locked = false,
    changed = 0;
  const resources = createNativeResourcesService({
    homeDir,
    env: {},
    withWrite: async (_agent, _project, operation) => {
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    },
    onSaved: async () => {
      expect(locked).toBe(true);
      expect((await environment.resolve('antigravity')).GEMINI_API_KEY).toBeUndefined();
      changed++;
    },
  });
  const save = environment.save;
  vi.spyOn(environment, 'save').mockImplementation(async (...args) => {
    expect(locked).toBe(true);
    return save(...args);
  });
  const service = createModelSettingsService({ resources, environment });
  const initial = await service.read('antigravity');
  vi.spyOn(environment, 'save').mockImplementationOnce(async (...args) => {
    expect(locked).toBe(true);
    const result = await save(...args);
    await writeFile(file, '{"model":"external"}');
    return result;
  });
  await expect(
    service.save('antigravity', { revision: initial.revision, changes: { apiKey: 'fixture-key', model: 'new' } }),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(changed).toBe(1);
  expect(locked).toBe(false);
  expect(JSON.parse(await readFile(file, 'utf8')).model).toBe('external');
});
