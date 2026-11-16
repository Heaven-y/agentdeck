import { mkdir, mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  antigravityLaunchSelection,
  AntigravityModelSelectionError,
} from '../../../src/agents/antigravity/model-launch';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(settings: object) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-agy-launch-test-'));
  const gemini = path.join(root, '.gemini');
  const native = path.join(gemini, 'antigravity-cli');
  const file = path.join(native, 'settings.json');
  await mkdir(gemini);
  await mkdir(native);
  const content = `\uFEFF${JSON.stringify(settings, null, 2)}\n`;
  await writeFile(file, content, 'utf8');
  cleanups.push(async () => {
    await unlink(file);
    await rmdir(native);
    await rmdir(gemini);
    await rmdir(root);
  });
  return { file, content, env: { HOME: root, USERPROFILE: root } };
}

const label = 'Gemini Example (High)';
const canonical = {
  modelName: 'gemini-example-high',
  label,
  maxTokens: 1000000,
  customParameter: { enabled: true, values: [1, 2] },
};
const other = {
  modelName: 'other-model',
  label: 'Other',
  maxTokens: 200000,
  request: { headers: { authorization: 'fixture-only-token' }, temperature: 0.4 },
};

it.each([
  { configured: label, requested: undefined },
  { configured: 'agentdeck-old', requested: undefined },
  { configured: 'Other', requested: 'agentdeck-old' },
  { configured: 'Other', requested: 'agentdeck-second' },
])(
  '启动消除同名等价遗留项（默认 $configured，显式 $requested），原配置保持逐字节不变',
  async ({ configured, requested }) => {
    const custom = {
      unknownNativeOption: { endpoint: 'https://example.test', enabled: false },
      customModels: {
        'agentdeck-old': { ...canonical, modelName: label },
        'agentdeck-current': canonical,
        'agentdeck-second': canonical,
        external: other,
      },
    };
    const f = await fixture({
      modelProvider: 'gemini',
      model: configured,
      authentication: 'fixture-only-secret',
      customModelsConfig: custom,
    });
    expect(await antigravityLaunchSelection(f.env, requested)).toEqual({
      model: label,
      contextWindow: { model: label, windowTokens: 1000000 },
      nativeSettings: {
        customModelsConfig: {
          unknownNativeOption: custom.unknownNativeOption,
          customModels: { 'agentdeck-current': canonical, external: other },
        },
      },
    });
    expect(await readFile(f.file, 'utf8')).toBe(f.content);
  },
);

it.each([
  { key: 'agentdeck-other', change: { modelName: 'different-model' } },
  { key: 'agentdeck-other', change: { maxTokens: 200000 } },
  { key: 'agentdeck-other', change: { customParameter: { enabled: false, values: [1, 2] } } },
  { key: 'user-owned', change: {} },
])('同名配置不等价或并非应用遗留时拒绝启动（$key，$change）', async ({ key, change }) => {
  const f = await fixture({
    modelProvider: 'gemini',
    model: 'agentdeck-current',
    customModelsConfig: {
      customModels: { 'agentdeck-current': canonical, [key]: { ...canonical, ...change } },
    },
  });
  await expect(antigravityLaunchSelection(f.env)).rejects.toBeInstanceOf(AntigravityModelSelectionError);
  expect(await readFile(f.file, 'utf8')).toBe(f.content);
});

it('没有等价重复时不生成临时覆盖，显式原生型号仍原样透传', async () => {
  const f = await fixture({
    modelProvider: 'gemini',
    model: 'agentdeck-current',
    customModelsConfig: { customModels: { 'agentdeck-current': canonical, external: other } },
  });
  expect(await antigravityLaunchSelection(f.env)).toEqual({
    model: label,
    contextWindow: { model: label, windowTokens: 1000000 },
  });
  expect(
    await antigravityLaunchSelection(f.env, 'gemini-native-high', async () => ({
      model: 'gemini-native-high',
      windowTokens: 1048576,
    })),
  ).toEqual({
    model: 'gemini-native-high',
    contextWindow: { model: 'gemini-native-high', windowTokens: 1048576 },
  });
});

it('原生默认按标签读取，显式键与其他标签重名时仍启动该键对应的模型', async () => {
  const f = await fixture({
    modelProvider: 'gemini',
    model: 'target',
    customModelsConfig: {
      customModels: {
        other: { modelName: 'native-other', label: 'target', maxTokens: 200000 },
        target: { modelName: 'native-target', label: 'Wanted', maxTokens: 1000000 },
      },
    },
  });
  expect(await antigravityLaunchSelection(f.env)).toEqual({
    model: 'target',
    contextWindow: { model: 'target', windowTokens: 200000 },
  });
  expect(await antigravityLaunchSelection(f.env, 'target')).toEqual({
    model: 'Wanted',
    contextWindow: { model: 'Wanted', windowTokens: 1000000 },
  });
  expect(await readFile(f.file, 'utf8')).toBe(f.content);
});

it('原生 ID 唯一映射自定义模型时使用其窗口，多个非等价别名时拒绝猜选', async () => {
  const f = await fixture({
    modelProvider: 'gemini',
    model: label,
    customModelsConfig: { customModels: { custom: canonical } },
  });
  expect(await antigravityLaunchSelection(f.env, canonical.modelName)).toEqual({
    model: label,
    contextWindow: { model: label, windowTokens: 1000000 },
  });
  await writeFile(
    f.file,
    JSON.stringify({
      modelProvider: 'gemini',
      customModelsConfig: {
        customModels: {
          custom: canonical,
          other: { ...canonical, label: 'Another', maxTokens: 200000 },
        },
      },
    }),
  );
  await expect(antigravityLaunchSelection(f.env, canonical.modelName)).rejects.toBeInstanceOf(
    AntigravityModelSelectionError,
  );
});

it.each([
  { model: { invalid: true } },
  { customModelsConfig: null },
  { customModelsConfig: { customModels: [] } },
  { customModelsConfig: { customModels: { invalid: null } } },
])('原始配置结构错误时明确拒绝启动，不把内部键当作原生型号（%j）', async (invalid) => {
  const f = await fixture({ modelProvider: 'gemini', ...invalid });
  await expect(antigravityLaunchSelection(f.env)).rejects.toBeInstanceOf(AntigravityModelSelectionError);
  await expect(antigravityLaunchSelection(f.env, 'agentdeck')).rejects.toBeInstanceOf(AntigravityModelSelectionError);
  expect(await readFile(f.file, 'utf8')).toBe(f.content);
});

it('内置模型也携带启动窗口快照，读取仅使用本次模型设置', async () => {
  const f = await fixture({ modelProvider: 'gemini', model: 'Native Example' });
  const readWindow = async (settings: { model?: string }, requested?: string) => {
    expect(settings.model).toBe('Native Example');
    expect(requested).toBe('native-example');
    return { model: 'native-example', windowTokens: 1048576 };
  };
  expect(await antigravityLaunchSelection(f.env, 'native-example', readWindow)).toEqual({
    model: 'native-example',
    contextWindow: { model: 'native-example', windowTokens: 1048576 },
  });
});

it('保存合并后已删除的应用模型键不能再原样发送给原生', async () => {
  const f = await fixture({
    modelProvider: 'gemini',
    model: label,
    customModelsConfig: { customModels: { 'agentdeck-current': canonical } },
  });
  await expect(antigravityLaunchSelection(f.env, 'agentdeck-window-0123456789ab')).rejects.toThrow('失效');
  expect(await readFile(f.file, 'utf8')).toBe(f.content);
});

it('临时设置文件保存完整覆盖，关闭后逐个删除文件和目录且可重复关闭', async () => {
  const { prepareNativeSettings } = await import('../../../src/agents/antigravity/native-settings-override');
  const settings = { customModelsConfig: { customModels: { canonical, external: other }, unknown: ['value'] } };
  const temporary = await prepareNativeSettings(settings);
  cleanups.push(() => temporary.close());
  expect(JSON.parse(await readFile(temporary.path, 'utf8'))).toEqual(settings);
  if (process.platform !== 'win32') expect((await stat(temporary.path)).mode & 0o777).toBe(0o600);
  await temporary.close();
  await expect(stat(temporary.path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(path.dirname(temporary.path))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(temporary.close()).resolves.toBeUndefined();
});
