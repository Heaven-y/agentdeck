// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProductSettingsSchema } from '@agentdeck/shared/settings';
import { ModelSettingsPanel } from '../../../../src/features/settings/models/ModelSettingsPanel';
import { settingsApi, settingsKeys } from '../../../../src/features/settings/api';
import { modelSettingsApi } from '../../../../src/features/settings/models/model-settings-api';
import { useChat } from '../../../../src/features/chat/state/chat-store';
import { queryClient } from '../../../../src/lib/query-client';
import { modelCandidates } from '../../../../src/cli/shared/model-candidates';

const models = [
  { id: 'one', label: 'one' },
  { id: 'two', label: 'two' },
];

function nativeDocument() {
  return {
    agent: 'claude' as const,
    revision: 'a'.repeat(64),
    displayPath: 'settings.json',
    fields: [{ key: 'model', label: '默认模型', value: '', group: 'model' as const }],
    warnings: [],
  };
}

function antigravityDocument() {
  const native = nativeDocument();
  return {
    ...native,
    agent: 'antigravity' as const,
    fields: [...native.fields, { key: 'modelProvider', label: '连接方式', value: '', group: 'connection' as const }],
  };
}

function mount() {
  return render(<ModelSettingsPanel agent="claude" guardRef={{ current: (action) => action() }} onNative={vi.fn()} />);
}

async function rangeCheckbox(name: string) {
  const input = await screen.findByRole<HTMLInputElement>('checkbox', { name });
  await waitFor(() => expect(input.disabled).toBe(false));
  return input;
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  useChat.setState(useChat.getInitialState(), true);
});

it('勾选模型只改草稿，点保存配置才写入显示范围', async () => {
  let product = { settings: ProductSettingsSchema.parse({}), revision: 'b'.repeat(64) };
  vi.spyOn(settingsApi, 'readProductSettings').mockImplementation(async () => product);
  const save = vi.spyOn(settingsApi, 'saveProductSettings').mockImplementation(async (input) => {
    product = { settings: input.settings, revision: 'c'.repeat(64) };
    return product;
  });
  vi.spyOn(modelSettingsApi, 'read').mockResolvedValue(nativeDocument());
  vi.spyOn(modelSettingsApi, 'catalog').mockResolvedValue({ models, entries: [], warnings: [] } as never);
  mount();

  const two = await rangeCheckbox('显示 two');
  fireEvent.click(two);
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText('保存设置后生效')).toBeTruthy();
  expect(screen.getByRole('button', { name: '保存配置' })).toHaveProperty('disabled', false);

  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![0].settings.modelVisibility).toEqual({ claude: ['one'] });
  await waitFor(() => expect(useChat.getState().defaults.modelVisibility).toEqual({ claude: ['one'] }));
  expect(await screen.findByText('当前已保存')).toBeTruthy();
});

it('恢复全部模型保存时删除该 CLI 的范围，不影响其他 CLI', async () => {
  let product = {
    settings: ProductSettingsSchema.parse({ modelVisibility: { codex: ['gpt'], claude: ['one'] } }),
    revision: 'b'.repeat(64),
  };
  vi.spyOn(settingsApi, 'readProductSettings').mockImplementation(async () => product);
  const save = vi.spyOn(settingsApi, 'saveProductSettings').mockImplementation(async (input) => {
    product = { settings: input.settings, revision: 'c'.repeat(64) };
    return product;
  });
  vi.spyOn(modelSettingsApi, 'read').mockResolvedValue(nativeDocument());
  vi.spyOn(modelSettingsApi, 'catalog').mockResolvedValue({ models, entries: [], warnings: [] } as never);
  mount();

  await rangeCheckbox('显示 two');
  expect((await rangeCheckbox('显示 two')).checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '恢复全部模型' }));
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![0].settings.modelVisibility).toEqual({ codex: ['gpt'] });
});

it('显示范围的草稿与原生表单一起受未保存保护', async () => {
  vi.spyOn(settingsApi, 'readProductSettings').mockImplementation(async () => ({
    settings: ProductSettingsSchema.parse({}),
    revision: 'b'.repeat(64),
  }));
  vi.spyOn(settingsApi, 'saveProductSettings').mockResolvedValue({
    settings: ProductSettingsSchema.parse({}),
    revision: 'c'.repeat(64),
  });
  vi.spyOn(modelSettingsApi, 'read').mockResolvedValue(nativeDocument());
  vi.spyOn(modelSettingsApi, 'catalog').mockResolvedValue({ models, entries: [], warnings: [] } as never);
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const leave = vi.fn();
  const guard: { current: (action: () => void) => void } = { current: (action) => action() };
  render(<ModelSettingsPanel agent="claude" guardRef={guard} onNative={vi.fn()} />);

  const two = await rangeCheckbox('显示 two');
  fireEvent.click(two);
  guard.current(leave);
  expect(leave).not.toHaveBeenCalled();
  vi.mocked(window.confirm).mockReturnValue(true);
  guard.current(leave);
  expect(leave).toHaveBeenCalledOnce();
});

it('Antigravity 官方模型去重后按原生 ID 保存，保留独立的 API Key 范围', async () => {
  let product = {
    settings: ProductSettingsSchema.parse({ modelVisibility: { 'antigravity-gemini': ['service-model'] } }),
    revision: 'b'.repeat(64),
  };
  vi.spyOn(settingsApi, 'readProductSettings').mockImplementation(async () => product);
  const save = vi.spyOn(settingsApi, 'saveProductSettings').mockImplementation(async (input) => {
    product = { settings: input.settings, revision: 'c'.repeat(64) };
    return product;
  });
  const aliases = [
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { id: 'agentdeck', label: 'Gemini 4 Argon (High)', modelId: 'Gemini 4 Argon (High)' },
    { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  ];
  vi.spyOn(modelSettingsApi, 'read').mockResolvedValue(antigravityDocument());
  vi.spyOn(modelSettingsApi, 'catalog').mockResolvedValue({
    antigravityConnection: 'account',
    models: aliases,
    entries: [],
    warnings: [],
  } as never);
  render(<ModelSettingsPanel agent="antigravity" guardRef={{ current: (action) => action() }} onNative={vi.fn()} />);

  await rangeCheckbox('显示 gemini-4-argon-high');
  expect(screen.queryByRole('checkbox', { name: '显示 agentdeck' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: '显示 gemini-4-argon-low' }));
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0]![0].settings.modelVisibility).toEqual({
    'antigravity-account': ['gemini-4-argon-high'],
    'antigravity-gemini': ['service-model'],
  });
  expect(queryClient.getQueryData(settingsKeys.productSettings)).toEqual(product);
});

it.each(['name', 'both'])('AGY 已保存的原生名称合并显示后仍可取消勾选（%s）', async (savedAs) => {
  const native = { id: 'gemini-example-high', label: 'Gemini Example (High)' };
  const named = { id: native.label, label: native.label };
  const other = { id: 'gemini-other-high', label: 'Gemini Other (High)' };
  const catalog = [named, native, other];
  const saved = savedAs === 'both' ? [native.id, named.id, other.id] : [named.id, other.id];
  let product = {
    settings: ProductSettingsSchema.parse({ modelVisibility: { 'antigravity-account': saved } }),
    revision: 'b'.repeat(64),
  };
  vi.spyOn(settingsApi, 'readProductSettings').mockImplementation(async () => product);
  const save = vi.spyOn(settingsApi, 'saveProductSettings').mockImplementation(async (input) => {
    product = { settings: input.settings, revision: 'c'.repeat(64) };
    return product;
  });
  vi.spyOn(modelSettingsApi, 'read').mockResolvedValue(antigravityDocument());
  vi.spyOn(modelSettingsApi, 'catalog').mockResolvedValue({
    antigravityConnection: 'account',
    models: catalog,
    entries: [],
    warnings: [],
  } as never);
  render(<ModelSettingsPanel agent="antigravity" guardRef={{ current: (action) => action() }} onNative={vi.fn()} />);

  const checkbox = await rangeCheckbox(`显示 ${native.id}`);
  expect(checkbox.checked).toBe(true);
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(product.settings.modelVisibility?.['antigravity-account']).toEqual([other.id]);
  expect(
    modelCandidates(catalog, other.id, product.settings.modelVisibility?.['antigravity-account'], 'antigravity'),
  ).toEqual([other]);
});
