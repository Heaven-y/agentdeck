// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProductSettingsSchema, type ProductSettingsDocument } from '@agentdeck/shared/settings';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { shortcutAction, useShortcuts } from '../../../src/app/navigation/shortcuts';
import { KeyboardShortcutsPanel } from '../../../src/features/settings/general/KeyboardShortcutsPanel';
import { settingsApi } from '../../../src/features/settings/api';

beforeEach(() => useShortcuts.getState().reset());

afterEach(() => {
  document.body.replaceChildren();
  cleanup();
  vi.restoreAllMocks();
});
function shortcut(target: HTMLElement = document.body, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, ...options });
  Object.defineProperty(event, 'target', { value: target });
  return shortcutAction(event, useShortcuts.getState().bindings) === 'search';
}
it('宽窗非模态终端和文件不阻断聊天快捷键，原生modal仍阻断', () => {
  const terminal = document.createElement('dialog');
  terminal.setAttribute('open', '');
  terminal.setAttribute('role', 'region');
  document.body.append(terminal);
  expect(shortcut()).toBe(true);
  terminal.setAttribute('role', 'complementary');
  expect(shortcut()).toBe(true);
  // jsdom不实现showModal；模拟浏览器:modal查询，实际原生门禁另有Edge验收。
  vi.spyOn(document, 'querySelector').mockReturnValue(terminal);
  expect(shortcut()).toBe(false);
});
it('保留IME、终端内部、已处理和其他组合键的原有含义', () => {
  const terminal = document.createElement('div');
  terminal.className = 'xterm';
  const input = document.createElement('textarea');
  terminal.append(input);
  document.body.append(terminal);
  expect(shortcut(input)).toBe(false);
  expect(shortcut(document.body, { isComposing: true })).toBe(false);
  expect(shortcut(document.body, { keyCode: 229 })).toBe(false);
  expect(shortcut(document.body, { shiftKey: true })).toBe(false);
  expect(shortcut(document.body, { repeat: true })).toBe(false);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  expect(shortcut(document.body, { ctrlKey: false, metaKey: true })).toBe(true);
});

it('设置可重绑、停用及恢复并写全局设置，冲突不覆盖另一操作，编辑按键保留原义', async () => {
  let document: ProductSettingsDocument = { settings: ProductSettingsSchema.parse({}), revision: 'missing' };
  vi.spyOn(settingsApi, 'readProductSettings').mockImplementation(() => Promise.resolve(document));
  const save = vi.spyOn(settingsApi, 'saveProductSettings').mockImplementation((input) => {
    document = { settings: input.settings, revision: 'a'.repeat(64) };
    return Promise.resolve(document);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KeyboardShortcutsPanel />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '修改新建会话快捷键' }).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '修改新建会话快捷键' }));
  const recorder = screen.getByRole('textbox', { name: '设置新建会话快捷键' });
  fireEvent.keyDown(recorder, { key: 'k', ctrlKey: true });
  expect(screen.getByRole('alert').textContent).toContain('搜索会话');
  fireEvent.keyDown(recorder, { key: 'u', ctrlKey: true, shiftKey: true });
  expect(useShortcuts.getState().bindings.newSession).toBe('Mod+Shift+U');
  await waitFor(() => expect(document.settings.shortcuts?.newSession).toBe('Mod+Shift+U'));
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '停用新建会话快捷键' }).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '停用新建会话快捷键' }));
  expect(useShortcuts.getState().bindings.newSession).toBeNull();
  await waitFor(() => expect(document.settings.shortcuts?.newSession).toBeNull());
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '恢复默认快捷键' }).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '恢复默认快捷键' }));
  expect(useShortcuts.getState().bindings.newSession).toBe('Mod+N');
  await waitFor(() => expect(document.settings.shortcuts).toEqual({}));
  expect(save).toHaveBeenCalledTimes(3);
  act(() => expect(useShortcuts.getState().bind('newSession', 'Mod+C')).toContain('编辑'));
  expect(useShortcuts.getState().bindings.newSession).toBe('Mod+N');
  client.clear();
});
