import { expect, it, vi } from 'vitest';
import {
  antigravityContextWindow,
  antigravityContextWindowSnapshot,
} from '../../../src/agents/antigravity/context-window';

const catalog = async () => ({
  models: {
    'gemini-example-high': { displayName: 'Gemini Example (High)', maxTokens: 1048576, maxOutputTokens: 65536 },
  },
  defaultAgentModelId: 'gemini-example-high',
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
