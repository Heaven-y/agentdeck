import { expect, it } from 'vitest';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_SPOTLIGHT,
  ProductSettingsInputSchema,
  ProductSettingsSchema,
  conversationWidth,
} from '../../src/settings/product-settings';

it('产品设置保存默认Agent、外观与服务器资源采样偏好', () => {
  const settings = ProductSettingsSchema.parse({
    defaultAgent: 'codex',
    resources: { intervalSeconds: 7, timeoutSeconds: 9 },
  });
  expect(settings).toEqual({
    spotlight: DEFAULT_SPOTLIGHT,
    appearance: DEFAULT_APPEARANCE,
    defaultAgent: 'codex',
    resources: { intervalSeconds: 7, timeoutSeconds: 9 },
  });
});

it('外观默认值与宽度换算固定', () => {
  const settings = ProductSettingsSchema.parse({});
  expect(settings.appearance).toEqual(DEFAULT_APPEARANCE);
  expect(settings.appearance.sessionLimit).toBe(5);
  expect(conversationWidth(settings.appearance.width)).toBe(860);
  expect(conversationWidth({ preset: 'small', custom: 900 })).toBe(720);
  expect(conversationWidth({ preset: 'large', custom: 900 })).toBe(1040);
  expect(conversationWidth({ preset: 'custom', custom: 900 })).toBe(900);
});

it('会话条数与自定义宽度超出范围时拒绝保存', () => {
  for (const appearance of [
    { sessionLimit: 0, width: { preset: 'medium', custom: 860 } },
    { sessionLimit: 21, width: { preset: 'medium', custom: 860 } },
    { sessionLimit: 5.5, width: { preset: 'medium', custom: 860 } },
    { sessionLimit: 5, width: { preset: 'custom', custom: 479 } },
    { sessionLimit: 5, width: { preset: 'custom', custom: 1401 } },
    { sessionLimit: 5, width: { preset: 'huge', custom: 860 } },
  ])
    expect(ProductSettingsSchema.safeParse({ appearance }).success).toBe(false);
});

it('光影默认开启，公开设置只保留开关', () => {
  const settings = ProductSettingsSchema.parse({});
  expect(settings.spotlight).toEqual({ enabled: true });
  for (const patch of [{ intensity: 80 }, { size: 0 }, { softness: -1 }, { color: 'url(example)' }]) {
    expect(ProductSettingsSchema.safeParse({ spotlight: { ...settings.spotlight, ...patch } }).success).toBe(false);
  }
});

it('同步域删除后，公开输入不再接受旧的同步偏好', () => {
  for (const retired of [{ syncDefaults: { maxFileBytes: 8388608 } }, { syncIntervalSeconds: 15 }]) {
    expect(ProductSettingsSchema.safeParse(retired).success).toBe(false);
    expect(ProductSettingsInputSchema.safeParse({ settings: retired, revision: 'missing' }).success).toBe(false);
  }
  expect(ProductSettingsSchema.parse({})).not.toHaveProperty('syncDefaults');
});

it.each([
  { claude: '', codex: '' },
  { claude: 'retired-model', codex: 'old-model' },
])('公开产品设置输入拒绝已退休的defaultModels：%j', (defaultModels) => {
  const settings = { defaultAgent: 'codex', defaultModels };
  expect(ProductSettingsSchema.safeParse(settings).success).toBe(false);
  expect(ProductSettingsInputSchema.safeParse({ settings, revision: 'missing' }).success).toBe(false);
});
