import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAntigravityProxyVariable } from '@agentdeck/shared/settings';
import { afterEach, expect, it } from 'vitest';
import { createLaunchEnvironment } from '../../src/settings/launch-environment';

const directories: string[] = [];
async function fixture(env: NodeJS.ProcessEnv = { ANTHROPIC_AUTH_TOKEN: 'inherited-secret', PATH: 'native-path' }) {
  const configDir = await mkdtemp(path.join(tmpdir(), 'agentdeck-env-test-'));
  directories.push(configDir);
  const service = createLaunchEnvironment({
    configDir,
    env,
    protector: {
      available: true,
      protect: async (value) => Buffer.from(value.toString('hex')),
      unprotect: async (value) => Buffer.from(value.toString(), 'hex'),
    },
  });
  return { service, configDir };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('环境状态不返回旧值，设置加密保存，停用不会继续继承', async () => {
  const { service, configDir } = await fixture();
  const initial = await service.read('claude');
  expect(initial.variables.find((item) => item.name === 'ANTHROPIC_AUTH_TOKEN')?.source).toBe('inherited');
  const saved = await service.save('claude', {
    revision: initial.revision,
    variables: [
      { name: 'ANTHROPIC_API_KEY', mode: 'set', value: 'fixture-new-secret' },
      { name: 'ANTHROPIC_AUTH_TOKEN', mode: 'disabled' },
    ],
  });
  expect(JSON.stringify(saved)).not.toContain('fixture-new-secret');
  expect(JSON.stringify(initial)).not.toContain('inherited-secret');
  expect(await service.readSecret('claude', { revision: saved.revision, name: 'ANTHROPIC_API_KEY' })).toEqual({
    value: 'fixture-new-secret',
  });
  await expect(
    service.readSecret('claude', { revision: initial.revision, name: 'ANTHROPIC_API_KEY' }),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  for (const name of ['PATH', 'OPENAI_API_KEY', 'ANTHROPIC_BASE_URL'])
    await expect(service.readSecret('claude', { revision: saved.revision, name })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  expect(await service.readSecret('claude', { revision: saved.revision, name: 'ANTHROPIC_AUTH_TOKEN' })).toEqual({
    value: null,
  });
  expect(await readFile(path.join(configDir, 'launch-environment.json'), 'utf8')).not.toContain('fixture-new-secret');
  expect(await service.resolve('claude')).toEqual({
    PATH: 'native-path',
    ANTHROPIC_API_KEY: 'fixture-new-secret',
    ANTHROPIC_AUTH_TOKEN: undefined,
  });
  const same = await service.save('claude', {
    revision: saved.revision,
    variables: [{ name: 'ANTHROPIC_API_KEY', mode: 'set' }],
  });
  expect((await service.resolve('claude')).ANTHROPIC_API_KEY).toBe('fixture-new-secret');
  await service.save('claude', {
    revision: same.revision,
    variables: [{ name: 'ANTHROPIC_API_KEY', mode: 'inherit' }],
  });
  expect((await service.resolve('claude')).ANTHROPIC_API_KEY).toBeUndefined();
});

it('拒绝加载器变量、跨CLI变量、重复变量和旧revision', async () => {
  const { service } = await fixture();
  for (const name of ['PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'OPENAI_API_KEY'])
    await expect(
      service.save('claude', { revision: 'missing', variables: [{ name, mode: 'set', value: 'bad' }] }),
    ).rejects.toThrow();
  await expect(
    service.save('claude', {
      revision: 'missing',
      variables: [
        { name: 'ANTHROPIC_API_KEY', mode: 'inherit' },
        { name: 'ANTHROPIC_API_KEY', mode: 'disabled' },
      ],
    }),
  ).rejects.toThrow();
  await service.save('claude', {
    revision: 'missing',
    variables: [{ name: 'ANTHROPIC_AUTH_TOKEN', mode: 'disabled' }],
  });
  await expect(service.save('codex', { revision: 'missing', variables: [] })).rejects.toThrow('修改');
  expect((await service.read('antigravity')).variables.map((item) => item.name)).toContain('GEMINI_API_KEY');
  expect((await service.read('antigravity')).variables.map((item) => item.name)).not.toContain('GOOGLE_API_KEY');
});

it('AGY 一个代理覆盖 HTTP/HTTPS 并保留本机回环，清空后恢复继承，其他 CLI 不受影响', async () => {
  const env = { https_proxy: 'http://inherited-proxy', no_proxy: '.example.invalid' };
  const { service } = await fixture(env);
  const initial = await service.read('antigravity');
  expect(initial.variables.find((item) => item.name === 'HTTPS_PROXY')?.source).toBe('inherited');
  await expect(
    service.save('antigravity', {
      revision: initial.revision,
      variables: [{ name: 'HTTPS_PROXY', mode: 'set', value: 'http://my-server/path' }],
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' });

  const saved = await service.save('antigravity', {
    revision: initial.revision,
    variables: [
      { name: 'HTTPS_PROXY', mode: 'set', value: 'http://proxy-user:fixture-password@my-server' },
      { name: 'HTTP_PROXY', mode: 'set', value: 'http://previous-proxy' },
      { name: 'NO_PROXY', mode: 'set', value: '*' },
      { name: 'GEMINI_API_KEY', mode: 'set', value: 'fixture-gemini-key' },
    ],
  });
  expect(JSON.stringify(saved)).not.toContain('fixture-password');
  expect(await service.readAntigravityProxy()).toEqual({ revision: saved.revision, address: 'http://my-server' });
  const address = 'http://proxy-user:fixture-password@my-server';
  const proxy = { HTTPS_PROXY: address, HTTP_PROXY: address, NO_PROXY: 'localhost,127.0.0.1,::1' };
  expect(await service.resolve('antigravity', isAntigravityProxyVariable)).toEqual(proxy);
  expect(await service.resolve('antigravity')).toEqual({ ...proxy, GEMINI_API_KEY: 'fixture-gemini-key' });
  expect(await service.resolve('codex')).toEqual(env);
  expect(await service.resolve('claude')).toEqual(env);
  const updated = await service.saveAntigravityProxy({ revision: saved.revision, address: 'http://new-proxy' });
  expect(updated.address).toBe('http://new-proxy');
  expect(await service.resolve('antigravity', isAntigravityProxyVariable)).toEqual({
    ...proxy,
    HTTP_PROXY: 'http://new-proxy',
    HTTPS_PROXY: 'http://new-proxy',
  });
  await service.saveAntigravityProxy({ revision: updated.revision, address: '' });
  expect(await service.resolve('antigravity', isAntigravityProxyVariable)).toEqual(env);
});
