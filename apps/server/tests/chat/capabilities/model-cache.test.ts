import { mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeCapabilityCatalog } from '../../../src/agents/capability-types';
import { nativeFeaturesFor, type AntigravityConnection } from '@agentdeck/shared/conversation';
import { createCapabilitiesService } from '../../../src/chat/capabilities/capabilities';
import * as files from '../../../src/platform/files/safe-file';
import { createHash } from 'node:crypto';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const fixtureRoot = path.resolve(root);
    if (
      path.dirname(fixtureRoot) !== path.resolve(tmpdir()) ||
      !path.basename(fixtureRoot).startsWith('agentdeck-model-cache-')
    )
      throw new Error('无效的测试临时目录');
    async function removeDirectory(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.resolve(directory, entry.name);
        if (!target.startsWith(`${fixtureRoot}${path.sep}`)) throw new Error('测试清理目标超出临时目录');
        if (entry.isDirectory()) await removeDirectory(target);
        else await unlink(target);
      }
      await rmdir(directory);
    }
    await removeDirectory(fixtureRoot);
  }
});

it('落盘期间刷新被替代后不能留下旧请求的目录，失败的新请求保留上次成功缓存', async () => {
  const f = await fixture();
  const service = createCapabilitiesService({ claude: f.provider }, f.options);
  await service.refresh(f.ws, 'claude');
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = files.writeConfigFile;
  vi.spyOn(files, 'writeConfigFile').mockImplementationOnce(async (...args) => {
    entered();
    await blocked;
    await write(...args);
  });
  f.provider.mockResolvedValueOnce({ ...f.catalog, models: [{ id: 'superseded', label: '旧请求结果' }] });
  const older = service.refresh(f.ws, 'claude');
  const rejected = expect(older).rejects.toMatchObject({ code: 'capabilities_refresh_superseded' });
  await writing;
  f.provider.mockRejectedValueOnce(new Error('刷新失败'));
  await expect(service.refresh(f.ws, 'claude')).rejects.toMatchObject({ code: 'capabilities_unavailable' });
  release();
  await rejected;
  expect((await createCapabilitiesService({}, f.options).read(f.ws, 'claude')).models).toEqual(f.catalog.models);
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-model-cache-'));
  roots.push(root);
  const ws = { id: 'project', name: '示例', dir: path.join(root, 'project') };
  const catalog: NativeCapabilityCatalog = {
    models: [
      {
        id: 'native-model',
        label: '原生模型',
        modelId: 'resolved-model',
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        orchestratorRoles: ['planner'],
      },
    ],
    defaultModel: 'native-model',
    defaultReasoningEffort: 'low',
    entries: [
      {
        id: 'private-skill',
        kind: 'skill',
        name: 'inspect',
        description: '私有技能说明',
        available: true,
        requiresSession: false,
        supportsArguments: true,
        invocation: { kind: 'skill', name: 'inspect', path: path.join(ws.dir, 'private-skill.md') },
      },
    ],
    warnings: ['私有诊断内容'],
    modelWarning: '',
  };
  const provider = vi.fn(async () => structuredClone(catalog));
  const options = { configDir: root };
  return { root, ws, catalog, provider, options };
}

it('重启后复用同一原生目录的模型，技能和诊断不落盘，手动刷新才重新发现', async () => {
  const f = await fixture();
  await createCapabilitiesService({ claude: f.provider }, f.options).refresh(f.ws, 'claude');
  const service = createCapabilitiesService({ claude: f.provider }, f.options);
  const cached = await service.read({ ...f.ws, id: 'new-project-id' }, 'claude');
  expect(cached).toMatchObject({ discovered: true, commandsDiscovered: false, models: f.catalog.models, entries: [] });
  expect(cached.defaultModel).toBe('native-model');
  expect(cached.defaultReasoningEffort).toBe('low');
  expect(cached.warnings).toEqual([]);
  expect(f.provider).toHaveBeenCalledTimes(1);
  await expect(service.prepare(f.ws, 'claude', { text: '/inspect' })).rejects.toMatchObject({
    code: 'capabilities_not_refreshed',
  });
  const stored = await readFile(path.join(f.root, 'model-cache', 'claude.json'), 'utf8');
  expect(stored).not.toContain('private-skill');
  expect(stored).not.toContain('私有');
  expect(stored).not.toContain(f.ws.dir);
  f.catalog.models = [{ id: 'new-model', label: '新模型' }];
  expect((await service.refresh(f.ws, 'claude')).models).toEqual(f.catalog.models);
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect((await service.read(f.ws, 'claude')).commandsDiscovered).toBe(true);
  expect((await createCapabilitiesService({}, f.options).read(f.ws, 'claude')).models).toEqual(f.catalog.models);
  expect((await service.read({ ...f.ws, dir: path.join(f.ws.dir, 'nested') }, 'claude')).discovered).toBe(false);
  expect((await service.read(f.ws, 'codex')).discovered).toBe(false);
});

it('磁盘仅恢复明确模型输入类型，运行功能不能随模型缓存跨进程启用', async () => {
  const f = await fixture();
  f.catalog.models[0]!.inputModalities = ['text'];
  f.catalog.features = nativeFeaturesFor('claude', {
    runtime: 'claude-sdk',
    cliVersion: '2.1.317',
    sdkVersion: '0.3.286',
    handshake: 'confirmed',
    implemented: ['images'],
  });
  const fresh = await createCapabilitiesService({ claude: f.provider }, f.options).refresh(f.ws, 'claude');
  expect(fresh.features?.images.available).toBe(true);
  const cached = await createCapabilitiesService({}, f.options).read(f.ws, 'claude');
  expect(cached.models[0]?.inputModalities).toEqual(['text']);
  expect(cached.features?.images.available).toBe(false);
  expect(await readFile(path.join(f.root, 'model-cache', 'claude.json'), 'utf8')).not.toContain('features');
});

it('配置保存清除磁盘与在途旧结果，其他 CLI 保留，下一次读取不重发发现', async () => {
  const f = await fixture();
  const service = createCapabilitiesService({ claude: f.provider, codex: f.provider }, f.options);
  await service.refresh(f.ws, 'claude');
  await service.refresh(f.ws, 'codex');
  let finish!: (value: NativeCapabilityCatalog) => void;
  f.provider.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = service.refresh(f.ws, 'codex');
  await service.invalidate('codex');
  finish(f.catalog);
  await expect(pending).rejects.toMatchObject({ code: 'capabilities_refresh_superseded' });
  const restarted = createCapabilitiesService({}, f.options);
  expect((await restarted.read(f.ws, 'codex')).discovered).toBe(false);
  expect((await restarted.read(f.ws, 'claude')).models).toEqual(f.catalog.models);
  expect(f.provider).toHaveBeenCalledTimes(3);
});

it('刷新模型失败保留已有模型，错误和未登录状态不会代替持久缓存', async () => {
  const f = await fixture();
  const service = createCapabilitiesService({ claude: f.provider }, f.options);
  await service.refresh(f.ws, 'claude');
  f.provider.mockResolvedValueOnce({
    models: [{ id: 'configured-model', label: '原生配置模型' }],
    entries: [],
    warnings: ['未登录'],
    modelWarning: '未登录',
  });
  const failed = await service.refresh(f.ws, 'claude');
  expect(failed.models.map((model) => model.id)).toEqual(['configured-model', 'native-model']);
  expect(failed.modelWarning).toBe('未登录');
  expect(failed.defaultModel).toBe('native-model');
  expect(failed.defaultReasoningEffort).toBe('low');
  expect((await createCapabilitiesService({}, f.options).read(f.ws, 'claude')).models).toEqual(f.catalog.models);
});

it('AGY 切换连接只读各自的模型目录，失败回退和重启不会串用', async () => {
  const f = await fixture();
  let connection: AntigravityConnection | undefined = 'account';
  const options = { ...f.options, antigravityConnection: async () => connection };
  const service = createCapabilitiesService({ antigravity: f.provider }, options);
  const official = { ...f.catalog, antigravityConnection: 'account' as const };
  f.provider.mockResolvedValueOnce(official);
  await service.refresh(f.ws, 'antigravity');

  connection = 'gemini';
  const unread = await service.read(f.ws, 'antigravity');
  expect(unread.models).toEqual([]);
  expect(unread).toMatchObject({ antigravityConnection: 'gemini', discovered: false });
  expect(await service.prepare(f.ws, 'antigravity', { text: '/inspect' })).toMatchObject({
    invocation: { kind: 'skill', name: 'inspect' },
  });
  expect(f.provider).toHaveBeenCalledTimes(1);
  const gemini = {
    ...f.catalog,
    antigravityConnection: 'gemini' as const,
    models: [{ id: 'gemini-only', label: 'Gemini 候选' }],
    defaultModel: 'gemini-only',
  };
  const failedGemini = {
    ...gemini,
    models: [],
    defaultModel: undefined,
    defaultReasoningEffort: undefined,
    modelWarning: '缺少 Key',
  };
  f.provider.mockResolvedValueOnce(failedGemini);
  const failed = await service.refresh(f.ws, 'antigravity');
  expect(failed).toMatchObject({ antigravityConnection: 'gemini', models: [], modelWarning: '缺少 Key' });
  expect(failed.defaultModel).toBeUndefined();
  expect(failed.defaultReasoningEffort).toBeUndefined();
  f.provider.mockResolvedValueOnce(gemini);
  await service.refresh(f.ws, 'antigravity');
  f.provider.mockResolvedValueOnce(failedGemini);
  expect(await service.refresh(f.ws, 'antigravity')).toMatchObject({
    models: gemini.models,
    defaultModel: gemini.defaultModel,
    modelWarning: '缺少 Key',
  });

  const restarted = createCapabilitiesService({}, options);
  expect(await restarted.read(f.ws, 'antigravity')).toMatchObject({
    antigravityConnection: 'gemini',
    models: gemini.models,
    defaultModel: gemini.defaultModel,
  });
  connection = 'account';
  for (const instance of [service, restarted]) {
    expect(await instance.read(f.ws, 'antigravity')).toMatchObject({
      antigravityConnection: 'account',
      models: official.models,
      defaultModel: official.defaultModel,
    });
  }
  connection = undefined;
  const unknown = await service.read(f.ws, 'antigravity');
  expect(unknown).toMatchObject({ discovered: false, models: [] });
  expect(unknown.antigravityConnection).toBeUndefined();

  await service.invalidate('antigravity');
  const afterSave = createCapabilitiesService({}, options);
  for (const mode of ['account', 'gemini'] as const) {
    connection = mode;
    for (const instance of [service, afterSave]) {
      expect(await instance.read(f.ws, 'antigravity')).toMatchObject({
        antigravityConnection: mode,
        discovered: false,
        models: [],
      });
    }
  }
  expect(f.provider).toHaveBeenCalledTimes(4);
});

it('AGY 拒绝发现中切换连接或发现来源不匹配的目录', async () => {
  const f = await fixture();
  let connection: AntigravityConnection = 'account';
  const options = { ...f.options, antigravityConnection: async () => connection };
  const service = createCapabilitiesService({ antigravity: f.provider }, options);
  const account = { ...f.catalog, antigravityConnection: 'account' as const };
  f.provider.mockImplementationOnce(async () => {
    connection = 'gemini';
    return account;
  });
  await expect(service.refresh(f.ws, 'antigravity')).rejects.toMatchObject({ code: 'capabilities_refresh_superseded' });
  f.provider.mockResolvedValueOnce(account);
  await expect(service.refresh(f.ws, 'antigravity')).rejects.toMatchObject({ code: 'capabilities_refresh_superseded' });
  expect(await service.read(f.ws, 'antigravity')).toMatchObject({ antigravityConnection: 'gemini', models: [] });
  connection = 'account';
  expect(await createCapabilitiesService({}, options).read(f.ws, 'antigravity')).toMatchObject({
    antigravityConnection: 'account',
    models: [],
  });
});

it('AGY 落盘期间切换连接，恢复先前同模式的成功目录', async () => {
  const f = await fixture();
  let connection: AntigravityConnection = 'account';
  const options = { ...f.options, antigravityConnection: async () => connection };
  const service = createCapabilitiesService({ antigravity: f.provider }, options);
  f.catalog.antigravityConnection = 'account';
  await service.refresh(f.ws, 'antigravity');

  const write = files.writeConfigFile;
  vi.spyOn(files, 'writeConfigFile').mockImplementationOnce(async (...args) => {
    connection = 'gemini';
    await write(...args);
  });
  f.provider.mockResolvedValueOnce({ ...f.catalog, models: [{ id: 'obsolete', label: '迟到结果' }] });
  await expect(service.refresh(f.ws, 'antigravity')).rejects.toMatchObject({ code: 'capabilities_refresh_superseded' });
  const restarted = createCapabilitiesService({}, options);
  expect(await restarted.read(f.ws, 'antigravity')).toMatchObject({ antigravityConnection: 'gemini', models: [] });
  connection = 'account';
  expect(await restarted.read(f.ws, 'antigravity')).toMatchObject({
    antigravityConnection: 'account',
    models: f.catalog.models,
  });
});

it.each([1, 2])('旧 v%i 派生缓存不复用，成功发现后写入当前格式', async (version) => {
  const f = await fixture();
  await createCapabilitiesService({ claude: f.provider }, f.options).refresh(f.ws, 'claude');
  const file = path.join(f.root, 'model-cache', 'claude.json');
  const directory = process.platform === 'win32' ? f.ws.dir.toLowerCase() : f.ws.dir;
  const key = createHash('sha256')
    .update(JSON.stringify(['claude', directory]))
    .digest('hex');
  const stored = { version, catalogs: [{ key, models: [{ id: 'legacy-model', label: '旧缓存模型' }] }] };
  await writeFile(file, JSON.stringify(stored));
  const cached = await createCapabilitiesService({}, f.options).read(f.ws, 'claude');
  expect(cached).toMatchObject({ discovered: false, models: [] });
  expect(cached.defaultModel).toBeUndefined();
  expect(cached.defaultReasoningEffort).toBeUndefined();
  const other = { ...f.ws, dir: path.join(f.root, 'other') };
  await createCapabilitiesService({ claude: f.provider }, f.options).refresh(other, 'claude');
  const upgraded = createCapabilitiesService({}, f.options);
  expect((await upgraded.read(f.ws, 'claude')).discovered).toBe(false);
  expect((await upgraded.read(other, 'claude')).models).toEqual(f.catalog.models);
});

it.each([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 3, identityVersion: 1 }])(
  'AGY 忽略身份未知的缓存 %j，显式刷新后才能跨进程复用',
  async ({ version, identityVersion }) => {
    const f = await fixture();
    const other = { ...f.ws, dir: path.join(f.root, 'other') };
    const keyOf = (directory: string) =>
      createHash('sha256')
        .update(JSON.stringify(['antigravity', process.platform === 'win32' ? directory.toLowerCase() : directory]))
        .digest('hex');
    const oldCatalog = {
      models: [
        { id: 'selection-a', label: '模型 A', modelId: 'native-id' },
        { id: 'native-id', label: '模型 B', modelId: 'other-native-id' },
      ],
      defaultModel: 'native-id',
      defaultReasoningEffort: 'high',
    };
    const keys = [keyOf(f.ws.dir), keyOf(other.dir)];
    const catalogId = createHash('sha256').update(JSON.stringify(oldCatalog)).digest('hex');
    const stored =
      version === 3
        ? {
            version,
            ...(identityVersion === undefined ? {} : { identityVersion }),
            directories: keys.map((key) => ({ key, catalog: catalogId })),
            catalogs: [{ id: catalogId, ...oldCatalog }],
          }
        : { version, catalogs: keys.map((key) => ({ key, ...oldCatalog })) };
    const directory = path.join(f.root, 'model-cache');
    await mkdir(directory);
    const file = path.join(directory, 'antigravity.json');
    const original = JSON.stringify(stored);
    await writeFile(file, original);
    f.catalog.models = oldCatalog.models;
    f.catalog.defaultModel = 'selection-a';
    f.catalog.antigravityConnection = 'account';
    const options = { ...f.options, antigravityConnection: async () => 'account' as const };
    const service = createCapabilitiesService({ antigravity: f.provider }, options);

    const unread = await service.read(f.ws, 'antigravity');
    expect(unread).toMatchObject({ discovered: false, models: [] });
    expect(unread.defaultModel).toBeUndefined();
    expect(unread.defaultReasoningEffort).toBeUndefined();
    expect(f.provider).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(original);

    expect((await service.refresh(f.ws, 'antigravity')).defaultModel).toBe('selection-a');
    expect(f.provider).toHaveBeenCalledTimes(1);
    const upgraded = JSON.parse(await readFile(file, 'utf8'));
    expect(upgraded).toMatchObject({ version: 3, identityVersion: 2 });
    expect(upgraded.directories).toHaveLength(1);
    const restarted = createCapabilitiesService({ antigravity: f.provider }, options);
    expect(await restarted.read(f.ws, 'antigravity')).toMatchObject({
      discovered: true,
      models: f.catalog.models,
      defaultModel: 'selection-a',
    });
    expect(await restarted.read(other, 'antigravity')).toMatchObject({ discovered: false, models: [] });
    expect(f.provider).toHaveBeenCalledTimes(1);

    await restarted.refresh(other, 'antigravity');
    const deduplicated = JSON.parse(await readFile(file, 'utf8'));
    expect(deduplicated.directories).toHaveLength(2);
    expect(deduplicated.catalogs).toHaveLength(1);
    const secondRestart = createCapabilitiesService({}, options);
    expect((await secondRestart.read(f.ws, 'antigravity')).defaultModel).toBe('selection-a');
    expect((await secondRestart.read(other, 'antigravity')).defaultModel).toBe('selection-a');
  },
);

it('较大的正常模型目录完整缓存，相同内容只存一份且修改一个目录不影响另一个', async () => {
  const f = await fixture();
  f.catalog.models = Array.from({ length: 600 }, (_, index) => ({ id: `model-${index}`, label: `模型${index}` }));
  const service = createCapabilitiesService({ claude: f.provider }, f.options);
  const other = { ...f.ws, dir: path.join(f.root, 'other') };
  await service.refresh(f.ws, 'claude');
  await service.refresh(other, 'claude');
  const file = path.join(f.root, 'model-cache', 'claude.json');
  const stored = await readFile(file, 'utf8');
  expect(stored.match(/"id":"model-599"/g)).toHaveLength(1);
  const restarted = createCapabilitiesService({}, f.options);
  expect((await restarted.read(f.ws, 'claude')).models).toHaveLength(600);
  expect((await restarted.read(other, 'claude')).models.at(-1)?.id).toBe('model-599');
  f.catalog.models = [{ id: 'project-only', label: '项目专属模型' }];
  await service.refresh(other, 'claude');
  const updated = createCapabilitiesService({}, f.options);
  expect((await updated.read(f.ws, 'claude')).models).toHaveLength(600);
  expect((await updated.read(other, 'claude')).models).toEqual(f.catalog.models);
});

it('同目录并发读取共享磁盘请求，超出文件预算的新目录不截断或擦除旧缓存', async () => {
  const f = await fixture();
  const service = createCapabilitiesService({ claude: f.provider }, f.options);
  await service.refresh(f.ws, 'claude');
  const read = vi.spyOn(files, 'readConfigFile');
  const restarted = createCapabilitiesService({}, f.options);
  const results = await Promise.all(Array.from({ length: 8 }, () => restarted.read(f.ws, 'claude')));
  expect(read).toHaveBeenCalledTimes(1);
  expect(results.every((result) => result.models[0]?.id === 'native-model')).toBe(true);
  f.catalog.models = Array.from({ length: 150 }, (_, index) => ({
    id: `large-${index}`,
    label: '完整目录',
    description: 'x'.repeat(2048),
  }));
  expect((await service.refresh(f.ws, 'claude')).models).toHaveLength(150);
  expect((await createCapabilitiesService({}, f.options).read(f.ws, 'claude')).models[0]?.id).toBe('native-model');
});

it('损坏缓存按首次使用处理且可被新的成功目录修复', async () => {
  const f = await fixture();
  await createCapabilitiesService({ claude: f.provider }, f.options).refresh(f.ws, 'claude');
  const file = path.join(f.root, 'model-cache', 'claude.json');
  await writeFile(file, '{broken');
  const service = createCapabilitiesService({ claude: f.provider }, f.options);
  expect((await service.read(f.ws, 'claude')).discovered).toBe(false);
  await service.refresh(f.ws, 'claude');
  expect((await createCapabilitiesService({}, f.options).read(f.ws, 'claude')).models).toEqual(f.catalog.models);
});

it('配置失效与磁盘读取交错时不回填旧目录，后续读取不复用旧 Promise', async () => {
  const f = await fixture();
  await createCapabilitiesService({ claude: f.provider }, f.options).refresh(f.ws, 'claude');
  const service = createCapabilitiesService({}, f.options);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readFile = files.readConfigFile;
  vi.spyOn(files, 'readConfigFile').mockImplementationOnce(async (...args) => {
    const snapshot = await readFile(...args);
    entered();
    await gate;
    return snapshot;
  });
  const old = service.read(f.ws, 'claude');
  await started;
  const invalidating = service.invalidate('claude');
  const fresh = service.read(f.ws, 'claude');
  release();
  await invalidating;
  expect((await old).discovered).toBe(false);
  expect((await fresh).discovered).toBe(false);
  expect((await service.read(f.ws, 'claude')).models).toEqual([]);
});
