import { mkdir, mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  antigravityLaunchSelection as resolveLaunchSelection,
  AntigravityModelSelectionError,
} from '../../../src/agents/antigravity/model-launch';

const antigravityLaunchSelection: typeof resolveLaunchSelection = (env, requested, readWindow) =>
  resolveLaunchSelection(env, requested, readWindow, { readEffort: async () => undefined });

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

it('临时窗口覆盖按所选原生型号读取默认强度，目录故障明确拒绝启动', async () => {
  const f = await fixture({
    modelProvider: 'gemini',
    model: label,
    customModelsConfig: { customModels: { custom: canonical } },
  });
  const effort = vi.fn(async () => 'high' as const);
  const selection = await resolveLaunchSelection(f.env, undefined, undefined, { readEffort: effort });
  expect(effort).toHaveBeenCalledWith(canonical.modelName, undefined, f.env);
  expect(selection.defaultReasoningEffort).toBe('high');
  await expect(
    resolveLaunchSelection(f.env, undefined, undefined, {
      readEffort: async () => {
        throw new Error('private-diagnostic');
      },
    }),
  ).rejects.toThrow('推理强度');
  const unavailable = vi.fn(async () => {
    throw new Error('目录不可用');
  });
  const explicit = await resolveLaunchSelection(f.env, undefined, undefined, {
    readEffort: unavailable,
    explicitEffort: 'low',
  });
  expect(explicit.model).toBeTruthy();
  expect(explicit.defaultReasoningEffort).toBeUndefined();
  expect(unavailable).not.toHaveBeenCalled();
});

it.each([undefined, 'agentdeck-current', canonical.modelName])(
  '有窗口的自定义模型使用临时唯一标签，保留原值与其他配置（%s）',
  async (requested) => {
    const customModelsConfig = {
      unknownNativeOption: { enabled: false },
      customModels: { 'agentdeck-current': canonical, external: other },
    };
    const f = await fixture({ modelProvider: 'gemini', model: label, customModelsConfig });
    const selection = await antigravityLaunchSelection(f.env, requested);
    expect(selection.model).toBeTruthy();
    expect(selection.model).not.toBe(label);
    expect(selection.model).not.toBe(canonical.modelName);
    expect(selection).toMatchObject({
      sessionModel: label,
      contextWindow: { model: label, windowTokens: 1000000 },
      nativeSettings: {
        customModelsConfig: {
          unknownNativeOption: customModelsConfig.unknownNativeOption,
          customModels: {
            'agentdeck-current': { ...canonical, label: selection.model },
            external: other,
          },
        },
      },
    });
    expect(await readFile(f.file, 'utf8')).toBe(f.content);
  },
);

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
    const selection = await antigravityLaunchSelection(f.env, requested);
    expect(selection.model).not.toBe(label);
    expect(selection).toEqual({
      model: selection.model,
      sessionModel: label,
      contextWindow: { model: label, windowTokens: 1000000 },
      nativeSettings: {
        customModelsConfig: {
          unknownNativeOption: custom.unknownNativeOption,
          customModels: { 'agentdeck-current': { ...canonical, label: selection.model }, external: other },
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

it('自定义窗口使用临时标签，显式内置原生型号仍原样透传', async () => {
  const f = await fixture({
    modelProvider: 'gemini',
    model: 'agentdeck-current',
    customModelsConfig: { customModels: { 'agentdeck-current': canonical, external: other } },
  });
  const selection = await antigravityLaunchSelection(f.env);
  expect(selection.model).not.toBe(label);
  expect(selection).toEqual({
    model: selection.model,
    sessionModel: label,
    contextWindow: { model: label, windowTokens: 1000000 },
    nativeSettings: {
      customModelsConfig: {
        customModels: { 'agentdeck-current': { ...canonical, label: selection.model }, external: other },
      },
    },
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
  const inherited = await antigravityLaunchSelection(f.env);
  expect(inherited.model).not.toBe('target');
  expect(inherited).toEqual({
    model: inherited.model,
    sessionModel: 'target',
    contextWindow: { model: 'target', windowTokens: 200000 },
    nativeSettings: {
      customModelsConfig: {
        customModels: {
          other: { modelName: 'native-other', label: inherited.model, maxTokens: 200000 },
          target: { modelName: 'native-target', label: 'Wanted', maxTokens: 1000000 },
        },
      },
    },
  });
  const explicit = await antigravityLaunchSelection(f.env, 'target');
  expect(explicit.model).not.toBe('Wanted');
  expect(explicit.model).not.toBe(inherited.model);
  expect(explicit).toEqual({
    model: explicit.model,
    sessionModel: 'Wanted',
    contextWindow: { model: 'Wanted', windowTokens: 1000000 },
    nativeSettings: {
      customModelsConfig: {
        customModels: {
          other: { modelName: 'native-other', label: 'target', maxTokens: 200000 },
          target: { modelName: 'native-target', label: explicit.model, maxTokens: 1000000 },
        },
      },
    },
  });
  expect(await readFile(f.file, 'utf8')).toBe(f.content);
});

it('原生 ID 唯一映射自定义模型时使用其窗口，多个非等价别名时拒绝猜选', async () => {
  const f = await fixture({
    modelProvider: 'gemini',
    model: label,
    customModelsConfig: { customModels: { custom: canonical } },
  });
  const selection = await antigravityLaunchSelection(f.env, canonical.modelName);
  expect(selection.model).not.toBe(label);
  expect(selection).toEqual({
    model: selection.model,
    sessionModel: label,
    contextWindow: { model: label, windowTokens: 1000000 },
    nativeSettings: { customModelsConfig: { customModels: { custom: { ...canonical, label: selection.model } } } },
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

it.each([undefined, 0])('没有有效窗口时沿用原标签和原生设置（%s）', async (maxTokens) => {
  const f = await fixture({
    modelProvider: 'gemini',
    model: label,
    customModelsConfig: { customModels: { custom: { ...canonical, maxTokens } } },
  });
  expect(await antigravityLaunchSelection(f.env)).toEqual({ model: label, contextWindow: { model: label } });
  expect(await readFile(f.file, 'utf8')).toBe(f.content);
});

it.each([undefined, 'custom'])('有窗口但没有原标签时回报原型号（选择 %s）', async (requested) => {
  const custom = { modelName: 'native-model', maxTokens: 1000000, extra: { option: true } };
  const f = await fixture({
    modelProvider: 'gemini',
    model: custom.modelName,
    customModelsConfig: { customModels: { custom } },
  });
  const selection = await antigravityLaunchSelection(f.env, requested);
  expect(selection.model).not.toBe(custom.modelName);
  expect(selection.sessionModel).toBe(custom.modelName);
  expect(selection.contextWindow).toEqual({ model: custom.modelName, windowTokens: 1000000 });
  expect(selection.nativeSettings?.customModelsConfig).toEqual({
    customModels: { custom: { ...custom, label: selection.model } },
  });
  expect(await readFile(f.file, 'utf8')).toBe(f.content);
});

it.each([
  {
    name: '已支持的旧格式',
    storedModel: 'gemini-api://my-server/models/native-model?mode=fixture#example',
    runtimeModel: 'native-model',
  },
  {
    name: '未识别的旧格式',
    storedModel: 'gemini-api://my-server/unsupported/native-model',
    runtimeModel: 'gemini-api://my-server/unsupported/native-model',
  },
  {
    name: '其他协议',
    storedModel: 'custom-api://my-server/models/native-model',
    runtimeModel: 'custom-api://my-server/models/native-model',
  },
])('临时窗口覆盖只转换已支持的模型 URI：$name', async ({ storedModel, runtimeModel }) => {
  const legacy = { modelName: storedModel, label: 'Legacy', maxTokens: 1000000, extra: { option: true } };
  const another = { modelName: 'gemini-api://my-server/models/other-model', label: 'Other', maxTokens: 200000 };
  const f = await fixture({
    modelProvider: 'gemini',
    model: legacy.label,
    customModelsConfig: { customModels: { legacy, another } },
  });
  const selection = await antigravityLaunchSelection(f.env);
  expect(selection.nativeSettings?.customModelsConfig).toEqual({
    customModels: { legacy: { ...legacy, modelName: runtimeModel, label: selection.model }, another },
  });
  expect(selection.sessionModel).toBe(legacy.label);
  expect(selection.contextWindow).toEqual({ model: legacy.label, windowTokens: 1000000 });
  expect(await readFile(f.file, 'utf8')).toBe(f.content);
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
