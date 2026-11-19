// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PermissionOptionsMenu } from '../../../../src/features/chat/controls/PermissionOptionsMenu';
import { useChat } from '../../../../src/features/chat/state/chat-store';
import { sessionsApi } from '../../../../src/features/sessions/api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each([
  ['claude', '自动审查', 'auto'],
  ['codex', '帮我批准', 'auto-review'],
  ['antigravity', '自动模式', 'auto'],
] as const)('%s 菜单选择会成为该 CLI 的新会话默认，可重置', async (agent, label, mode) => {
  const save = vi
    .spyOn(sessionsApi, 'savePermissionDefault')
    .mockImplementation(async (_agent, permission) => ({ permission }));
  useChat.setState(useChat.getInitialState(), true);
  useChat.getState().newSession(agent);
  const { rerender } = render(<PermissionOptionsMenu disabled={false} />);
  const trigger = screen.getByRole('button', { name: '权限模式' });
  expect(trigger.textContent).toBe('跟随 CLI');
  expect(trigger.getAttribute('title')).toBe('由 CLI 决定权限；手动选择也会用于该 CLI 的新会话');
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('menuitemradio', { name: new RegExp('^' + label) }));
  await waitFor(() => expect(trigger.textContent).toContain(label));
  expect(save).toHaveBeenLastCalledWith(agent, { agent, mode });
  act(() => useChat.getState().newSession(agent));
  expect(trigger.textContent).toContain(label);
  rerender(<PermissionOptionsMenu disabled />);
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
  rerender(<PermissionOptionsMenu disabled={false} />);
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('menuitem', { name: '重置权限' }));
  await waitFor(() => expect(trigger.textContent).toBe('跟随 CLI'));
  expect(save).toHaveBeenLastCalledWith(agent, null);
});
