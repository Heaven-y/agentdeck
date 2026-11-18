// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { ProductSettingsSchema, type LaunchEnvironmentDocument } from '@agentdeck/shared/settings';
import SettingsDialog from '../../../../src/features/settings/SettingsDialog';
import LaunchEnvironmentPanel from '../../../../src/features/settings/environment/LaunchEnvironmentPanel';
import {
  SettingsNavigationContext,
  guardSettingsNavigation,
  type SettingsNavigation,
} from '../../../../src/features/settings/navigation/settings-navigation';
import { queryClient } from '../../../../src/lib/query-client';

const environment: LaunchEnvironmentDocument = {
  agent: 'codex',
  revision: 'a'.repeat(64),
  encryptionAvailable: true,
  note: '仅补充原生配置不能表达的启动变量。',
  variables: [
    { name: 'OPENAI_API_KEY', label: 'API 密钥', sensitive: true, mode: 'set', source: 'configured', hasValue: true },
    {
      name: 'OPENAI_BASE_URL',
      label: '服务地址',
      sensitive: false,
      mode: 'inherit',
      source: 'inherited',
      hasValue: true,
    },
  ],
};
let response: LaunchEnvironmentDocument;
let conflict = false;
let fetchMock: MockInstance<typeof fetch>;
async function openEnvironment() {
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsDialog onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '模型与连接' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Codex' }));
  fireEvent.click(await screen.findByText('高级设置'));
  fireEvent.click(await screen.findByRole('button', { name: 'CLI 环境变量' }));
  await screen.findByRole('heading', { name: 'CLI 环境变量 · Codex' });
  return screen.findByLabelText('API 密钥模式');
}
beforeEach(() => {
  response = environment;
  conflict = false;
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input as string;
    if (url === '/api/settings/product')
      return Response.json({ settings: ProductSettingsSchema.parse({}), revision: 'missing' });
    if (url.startsWith('/api/settings/models/'))
      return Response.json({
        agent: url.split('/').at(-1),
        revision: 'missing',
        displayPath: 'settings.json',
        fields: [],
        warnings: [],
      });
    if (url === '/api/settings/environment') return Response.json({ tools: [], checkedAt: 1 });
    if (url.endsWith('/restart')) return new Response(null, { status: 204 });
    if (url.endsWith('/secret')) return Response.json({ value: 'synthetic-saved-key' });
    if (init?.method === 'PUT' && conflict)
      return Response.json({ message: '启动环境已变化，请重新读取。' }, { status: 409 });
    if (url === '/api/settings/launch-environment/codex') return Response.json(response);
    throw new Error(`未声明的测试接口：${url}`);
  });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
});
afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  queryClient.clear();
  vi.restoreAllMocks();
});

it('启动环境只显示来源，新值显式保存且保存后清空；重启由单独操作触发', async () => {
  await openEnvironment();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('工作台设置')).toBeTruthy();
  expect(screen.getByText('继承进程环境')).toBeTruthy();
  const secret = screen.getByLabelText<HTMLInputElement>('API 密钥新值');
  expect(secret.value).toBe('');
  expect(secret.type).toBe('password');
  fireEvent.change(secret, { target: { value: 'synthetic-new-secret' } });
  const writesBefore = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT').length;
  fireEvent.click(screen.getByRole('button', { name: '显示API 密钥新值' }));
  expect(secret.type).toBe('text');
  expect(secret.value).toBe('synthetic-new-secret');
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(writesBefore);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '重新启动 CLI' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '保存环境变量' }));
  await screen.findByText(/启动环境已保存/);
  const saved = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(saved[1]?.body as string)).toEqual({
    revision: 'a'.repeat(64),
    variables: [{ name: 'OPENAI_API_KEY', mode: 'set', value: 'synthetic-new-secret' }],
  });
  expect(screen.getByLabelText<HTMLInputElement>('API 密钥新值').value).toBe('');
  expect(screen.getByLabelText<HTMLInputElement>('API 密钥新值').type).toBe('password');
  expect(fetchMock.mock.calls.some(([url]) => (url as string).endsWith('/secret'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '显示API 密钥新值' }));
  await screen.findByDisplayValue('synthetic-saved-key');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存环境变量' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '隐藏API 密钥新值' }));
  expect(screen.getByLabelText<HTMLInputElement>('API 密钥新值').value).toBe('');
  expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain('synthetic-new-secret');
  expect(fetchMock.mock.calls.some(([url]) => (url as string).endsWith('/restart'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '重新启动 CLI' }));
  await screen.findByText(/下一次发送时将重新启动/);
  expect(fetchMock.mock.calls.filter(([url]) => (url as string).endsWith('/restart'))).toHaveLength(1);
});

it('停用和恢复继承不发送旧密钥；冲突保留新值与未保存保护', async () => {
  await openEnvironment();
  fireEvent.change(screen.getByLabelText('API 密钥模式'), { target: { value: 'disabled' } });
  fireEvent.click(screen.getByRole('button', { name: '保存环境变量' }));
  await screen.findByText(/启动环境已保存/);
  const saved = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(saved[1]?.body as string)).toMatchObject({
    variables: [{ name: 'OPENAI_API_KEY', mode: 'disabled' }],
  });
  conflict = true;
  fireEvent.change(screen.getByLabelText('API 密钥新值'), { target: { value: 'synthetic-retained-draft' } });
  fireEvent.click(screen.getByRole('button', { name: '保存环境变量' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText<HTMLInputElement>('API 密钥新值').value).toBe('synthetic-retained-draft');
  fireEvent.click(screen.getByRole('button', { name: '返回模型设置' }));
  expect(screen.getByRole('heading', { name: 'CLI 环境变量 · Codex' })).toBeTruthy();
  expect(window.confirm).toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('API 密钥模式'), { target: { value: 'inherit' } });
  expect(screen.queryByLabelText('API 密钥新值')).toBeNull();
});

it('环境变量新值接入统一导航，取消离开保留草稿，确认离开后清除', async () => {
  const navigation: SettingsNavigation = new Map();
  const leave = vi.fn();
  render(
    <SettingsNavigationContext.Provider value={navigation}>
      <LaunchEnvironmentPanel agent="codex" embedded onBack={vi.fn()} onClose={vi.fn()} />
    </SettingsNavigationContext.Provider>,
  );
  const secret = await screen.findByLabelText<HTMLInputElement>('API 密钥新值');
  fireEvent.change(secret, { target: { value: 'synthetic-sensitive-draft' } });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: '关闭设置' })).toBeNull();
  act(() => guardSettingsNavigation(navigation, leave));
  expect(leave).not.toHaveBeenCalled();
  expect(secret.value).toBe('synthetic-sensitive-draft');
  vi.mocked(window.confirm).mockReturnValue(true);
  act(() => guardSettingsNavigation(navigation, leave));
  expect(leave).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('API 密钥新值')).toBeNull();
});

it('加密不可用时禁止重填密钥，但允许显式停用该变量', async () => {
  response = { ...environment, encryptionAvailable: false };
  await openEnvironment();
  expect(screen.getByLabelText<HTMLInputElement>('API 密钥新值').disabled).toBe(true);
  expect(
    within(screen.getByLabelText('API 密钥模式')).getByRole<HTMLOptionElement>('option', {
      name: '在工作台中单独设置',
      hidden: true,
    }).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('API 密钥模式'), { target: { value: 'disabled' } });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存环境变量' }).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '保存环境变量' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
});
