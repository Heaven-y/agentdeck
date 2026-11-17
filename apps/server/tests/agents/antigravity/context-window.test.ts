import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as executable from '../../../src/platform/process/executable';
import { startManagementBackend } from '../../../src/agents/antigravity/management-process';
import {
  antigravityContextWindow,
  antigravityContextWindowSnapshot,
  antigravityDefaultReasoningEffort,
  invalidateAntigravityModelCatalog,
} from '../../../src/agents/antigravity/context-window';

vi.mock('../../../src/agents/antigravity/discovery-profile', () => ({
  withAntigravityDiscoveryProfile: async (
    _settings: unknown,
    env: NodeJS.ProcessEnv,
    run: (profile: { root: string; gemini: string; env: NodeJS.ProcessEnv }) => Promise<unknown>,
  ) => run({ root: 'isolated', gemini: 'isolated-gemini', env: { ...env, LOCALAPPDATA: 'isolated-local' } }),
}));
vi.mock('../../../src/agents/antigravity/management-process', () => ({ startManagementBackend: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const catalog = async () => ({
  models: {
    'gemini-example-high': { displayName: 'Gemini Example (High)', maxTokens: 1048576, maxOutputTokens: 65536 },
  },
  defaultAgentModelId: 'gemini-example-high',
});

it('原生命令仅在真实 LOCALAPPDATA 中时，先解析再启动隔离目录发现', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-agy-catalog-test-'));
  const local = path.join(root, 'local');
  const agy = path.join(local, 'agy');
  const bin = path.join(agy, 'bin');
  const command = path.join(bin, 'agy.exe');
  await mkdir(local);
  await mkdir(agy);
  await mkdir(bin);
  await writeFile(command, 'fixture');
  try {
    vi.mocked(startManagementBackend).mockResolvedValue({
      request: async () => ({ response: { models: { example: { thinkingLevel: 3 } } } }),
      close: async () => {},
    });
    expect(await antigravityDefaultReasoningEffort('example', undefined, { PATH: '', LOCALAPPDATA: local })).toBe(
      'high',
    );
    const launched = vi.mocked(startManagementBackend).mock.calls[0]![0];
    expect(launched.command).toEqual({ command, args: [] });
    expect(launched.env.LOCALAPPDATA).toBe('isolated-local');
  } finally {
    await unlink(command);
    await rmdir(bin);
    await rmdir(agy);
    await rmdir(local);
    await rmdir(root);
  }
});

it('目录缓存区分同一可执行文件的不同参数', async () => {
  vi.spyOn(executable, 'resolveLocalCommand').mockImplementation((_name, env) => ({
    command: 'fixture-node',
    args: [env?.AGY_TEST_VARIANT ?? ''],
  }));
  vi.mocked(startManagementBackend).mockImplementation(async ({ command }) => ({
    request: async () => ({
      response: { models: { example: { thinkingLevel: command?.args[0] === 'first' ? 3 : 1 } } },
    }),
    close: async () => {},
  }));
  const first = { PATH: '', AGY_TEST_VARIANT: 'first' };
  const second = { PATH: '', AGY_TEST_VARIANT: 'second' };
  expect(await antigravityDefaultReasoningEffort('example', undefined, first)).toBe('high');
  expect(await antigravityDefaultReasoningEffort('example', undefined, second)).toBe('low');
  expect(startManagementBackend).toHaveBeenCalledTimes(2);
});

it('较早的目录读取失败不清除其他命令的成功缓存', async () => {
  vi.spyOn(executable, 'resolveLocalCommand').mockImplementation((_name, env) => ({
    command: 'concurrent-node',
    args: [env?.AGY_TEST_VARIANT ?? ''],
  }));
  let failFirst!: (error: Error) => void;
  const failing = new Promise<{ response: { models: { example: { thinkingLevel: number } } } }>((_resolve, reject) => {
    failFirst = reject;
  });
  vi.mocked(startManagementBackend).mockImplementation(async ({ command }) => ({
    request: async () =>
      command?.args[0] === 'first' ? failing : { response: { models: { example: { thinkingLevel: 2 } } } },
    close: async () => {},
  }));
  const first = antigravityDefaultReasoningEffort('example', undefined, { AGY_TEST_VARIANT: 'first' });
  const rejected = expect(first).rejects.toThrow();
  const second = { AGY_TEST_VARIANT: 'second' };
  expect(await antigravityDefaultReasoningEffort('example', undefined, second)).toBe('medium');
  failFirst(new Error('模拟失败'));
  await rejected;
  expect(await antigravityDefaultReasoningEffort('example', undefined, second)).toBe('medium');
  expect(startManagementBackend).toHaveBeenCalledTimes(2);
});

it('安装更新后同一命令重新读取，旧的在途失败不清新缓存', async () => {
  vi.spyOn(executable, 'resolveLocalCommand').mockReturnValue({ command: 'installed-fixture', args: [] });
  let failFirst!: (error: Error) => void;
  const failing = new Promise<{ response: { models: { example: { thinkingLevel: number } } } }>((_resolve, reject) => {
    failFirst = reject;
  });
  let starts = 0;
  vi.mocked(startManagementBackend).mockImplementation(async () => {
    const first = ++starts === 1;
    return {
      request: async () => (first ? failing : { response: { models: { example: { thinkingLevel: 3 } } } }),
      close: async () => {},
    };
  });
  const first = antigravityDefaultReasoningEffort('example');
  const rejected = expect(first).rejects.toThrow();
  invalidateAntigravityModelCatalog();
  expect(await antigravityDefaultReasoningEffort('example')).toBe('high');
  failFirst(new Error('旧目录失败'));
  await rejected;
  expect(await antigravityDefaultReasoningEffort('example')).toBe('high');
  expect(startManagementBackend).toHaveBeenCalledTimes(2);
});

it.each([
  { name: '缺失模型目录', models: null },
  { name: '模型目录是数组', models: [] },
  { name: '模型目录为空', models: {} },
  { name: '命中项格式错误', models: { example: null } },
])('拒绝畸形目录且不缓存：$name', async ({ models }) => {
  vi.spyOn(executable, 'resolveLocalCommand').mockReturnValue({ command: 'invalid-catalog', args: [] });
  vi.mocked(startManagementBackend).mockResolvedValue({
    request: async () => ({ response: { models } }),
    close: async () => {},
  });
  await expect(antigravityDefaultReasoningEffort('example')).rejects.toThrow();
  await expect(antigravityDefaultReasoningEffort('example')).rejects.toThrow();
  expect(startManagementBackend).toHaveBeenCalledTimes(2);
});

it('只按原生目录精确型号读取支持的默认思考强度', async () => {
  const discover = async () => ({
    models: {
      'example-low': { thinkingLevel: 1 },
      'example-medium': { thinkingLevel: 2 },
      'example-high': { thinkingLevel: 3 },
      'example-other': {},
      'example-unsupported': { thinkingLevel: 4 },
      'example-budget': { supportsThinking: true, thinkingBudget: -1 },
    },
  });
  expect(await antigravityDefaultReasoningEffort('example-low', discover)).toBe('low');
  expect(await antigravityDefaultReasoningEffort('example-medium', discover)).toBe('medium');
  expect(await antigravityDefaultReasoningEffort('example-high', discover)).toBe('high');
  expect(await antigravityDefaultReasoningEffort('example-high-suffix', discover)).toBeUndefined();
  expect(await antigravityDefaultReasoningEffort('example-other', discover)).toBeUndefined();
  await expect(antigravityDefaultReasoningEffort('example-unsupported', discover)).rejects.toThrow();
  await expect(antigravityDefaultReasoningEffort('example-budget', discover)).rejects.toThrow();
});

it('思考强度目录读取失败或超时时不静默使用原生默认', async () => {
  await expect(
    antigravityDefaultReasoningEffort('example-high', async () => {
      throw new Error('目录错误');
    }),
  ).rejects.toThrow();
  vi.useFakeTimers();
  try {
    const pending = antigravityDefaultReasoningEffort('example-high', () => new Promise(() => {}));
    const rejected = expect(pending).rejects.toThrow();
    let finished = false;
    void pending.catch(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

it('窗口与原生 /context 一致：自定义取显式 maxTokens，不扣历史生成的输出预留', async () => {
  const settings = {
    modelProvider: 'gemini',
    model: 'Custom',
    customModelsConfig: {
      customModels: {
        custom: { modelName: 'gemini-example-high', label: 'Custom', maxTokens: 1000000 },
      },
    },
  };
  const discover = vi.fn(catalog);
  expect(await antigravityContextWindow(settings, undefined, discover)).toEqual({
    model: 'Custom',
    windowTokens: 1000000,
  });
  expect(await antigravityContextWindow(settings, 'custom', discover)).toEqual({
    model: 'Custom',
    windowTokens: 1000000,
  });
  expect(discover).not.toHaveBeenCalled();
});

it('自定义条目没有窗口时遵循原生 Unknown，不借用同名内置型号窗口', async () => {
  const discover = vi.fn(catalog);
  expect(
    await antigravityContextWindow(
      {
        modelProvider: 'gemini',
        model: 'Custom',
        customModelsConfig: {
          customModels: {
            custom: { modelName: 'gemini-example-high', label: 'Custom' },
          },
        },
      },
      undefined,
      discover,
    ),
  ).toEqual({ model: 'Custom' });
  expect(discover).not.toHaveBeenCalled();
});

it('内置默认与显式选择从原生目录读取，不写死家族窗口，未知型号保持未知', async () => {
  expect(await antigravityContextWindow({}, undefined, catalog)).toEqual({
    model: 'Gemini Example (High)',
    windowTokens: 1048576,
  });
  expect(await antigravityContextWindow({}, 'gemini-example-high', catalog)).toEqual({
    model: 'gemini-example-high',
    windowTokens: 1048576,
  });
  expect(await antigravityContextWindow({}, 'unknown', catalog)).toEqual({ model: 'unknown' });
});

it('原始配置中的非字符串模型不能作为界面字段或原生默认值返回', async () => {
  await expect(
    antigravityContextWindow({ model: { invalid: true } as unknown as string }, undefined, catalog),
  ).rejects.toThrow('模型');
});

it('上下文窗口按原生默认标签或本次显式键选择，不让另一条同名键改变窗口', async () => {
  const settings = {
    modelProvider: 'gemini',
    model: 'target',
    customModelsConfig: {
      customModels: {
        other: { modelName: 'native-other', label: 'target', maxTokens: 200000 },
        target: { modelName: 'native-target', label: 'Wanted', maxTokens: 1000000 },
      },
    },
  };
  expect(await antigravityContextWindow(settings, undefined, catalog)).toEqual({
    model: 'target',
    windowTokens: 200000,
  });
  expect(await antigravityContextWindow(settings, 'target', catalog)).toEqual({
    model: 'Wanted',
    windowTokens: 1000000,
  });
});

it('无关空模型条目也必须先报配置错误，不能给出与启动不同的窗口', async () => {
  await expect(
    antigravityContextWindow(
      {
        modelProvider: 'gemini',
        model: 'Custom',
        customModelsConfig: {
          customModels: {
            invalid: null as unknown as { modelName: string },
            custom: { modelName: 'native-model', label: 'Custom', maxTokens: 1000000 },
          },
        },
      },
      'custom',
      catalog,
    ),
  ).rejects.toThrow('配置');
});

it('启动窗口最多等一秒，目录晚到失败也不阻断发送或回填旧窗口', async () => {
  vi.useFakeTimers();
  try {
    let reject!: (error: Error) => void;
    const pending = new Promise<{ model: string }>((_resolve, fail) => {
      reject = fail;
    });
    const snapshot = antigravityContextWindowSnapshot({ modelProvider: 'gemini' }, 'native-model', () => pending);
    let finished = false;
    void snapshot.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await snapshot).toEqual({ model: 'native-model' });
    reject(new Error('目录读取失败'));
    await Promise.resolve();
    expect(await snapshot).toEqual({ model: 'native-model' });
  } finally {
    vi.useRealTimers();
  }
});

it('目录失败时窗口未知，账号模式和未选择模型不会发起目录查询', async () => {
  const read = vi.fn(async () => {
    throw new Error('目录读取失败');
  });
  expect(await antigravityContextWindowSnapshot({ modelProvider: 'gemini' }, 'native-model', read)).toEqual({
    model: 'native-model',
  });
  read.mockClear();
  expect(await antigravityContextWindowSnapshot({}, 'account-model', read)).toEqual({ model: 'account-model' });
  expect(await antigravityContextWindowSnapshot({ modelProvider: 'gemini' }, undefined, read)).toEqual({});
  expect(read).not.toHaveBeenCalled();
});
