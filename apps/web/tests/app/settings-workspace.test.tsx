// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsWorkspace, useSettingsWorkspace } from '../../src/app/SettingsWorkspace';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('设置替换整个工作区时保留原会话与插件节点、草稿和后台更新', () => {
  const unmounted = vi.fn();
  function Workbench() {
    const [events, setEvents] = useState(0);
    useEffect(() => {
      const receive = () => setEvents((value) => value + 1);
      window.addEventListener('workspace-test-event', receive);
      return () => {
        window.removeEventListener('workspace-test-event', receive);
        unmounted();
      };
    }, []);
    return (
      <>
        <textarea aria-label="会话草稿" />
        <input aria-label="插件草稿" />
        <output>后台事件 {events}</output>
      </>
    );
  }
  const tree = (opened: boolean) => (
    <SettingsWorkspace opened={opened} settings={<section aria-label="设置页面">完整设置</section>}>
      <Workbench />
    </SettingsWorkspace>
  );
  const view = render(tree(false));
  const conversation = screen.getByRole('textbox', { name: '会话草稿' });
  const plugin = screen.getByRole('textbox', { name: '插件草稿' });
  fireEvent.change(conversation, { target: { value: '未发送内容' } });
  fireEvent.change(plugin, { target: { value: '未提交命令' } });
  view.rerender(tree(true));
  const hidden = conversation.closest('[hidden]');
  expect(hidden).not.toBeNull();
  expect(hidden!.hasAttribute('inert')).toBe(true);
  expect(screen.queryByRole('textbox', { name: '会话草稿' })).toBeNull();
  expect(screen.getByRole('region', { name: '设置页面' })).toBeTruthy();
  act(() => {
    window.dispatchEvent(new Event('workspace-test-event'));
  });
  view.rerender(tree(false));
  expect(screen.getByRole('textbox', { name: '会话草稿' })).toBe(conversation);
  expect((conversation as HTMLTextAreaElement).value).toBe('未发送内容');
  expect(screen.getByRole('textbox', { name: '插件草稿' })).toBe(plugin);
  expect((plugin as HTMLInputElement).value).toBe('未提交命令');
  expect(screen.getByText('后台事件 1')).toBeTruthy();
  expect(screen.queryByRole('region', { name: '设置页面' })).toBeNull();
  expect(unmounted).not.toHaveBeenCalled();
});

it('离开被拒绝时不导航，批准后只调用一次保护并保留插件失败返回值', () => {
  const { result } = renderHook(useSettingsWorkspace);
  act(() => result.current.open());
  expect(result.current.conversationVisible).toBe(false);
  const navigate = vi.fn();
  const reject = vi.fn();
  result.current.guardRef.current = reject;
  act(() => expect(result.current.navigate(navigate)).toBe(false));
  expect(reject).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  expect(result.current.opened).toBe(true);

  const accept = vi.fn((action: () => void) => action());
  result.current.guardRef.current = accept;
  act(() => expect(result.current.navigate(() => false)).toBe(false));
  expect(result.current.opened).toBe(true);
  accept.mockClear();
  act(() => expect(result.current.navigate(navigate)).toBe(true));
  expect(accept).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledOnce();
  expect(result.current.opened).toBe(false);
  expect(result.current.conversationVisible).toBe(true);
});

it('返回工作台不重复调用设置内部保护，并恢复最初触发点焦点', () => {
  let restore: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    restore = callback;
    return 1;
  });
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  const { result } = renderHook(useSettingsWorkspace);
  act(() => result.current.open());
  const guard = vi.fn();
  result.current.guardRef.current = guard;
  const settingsButton = document.createElement('button');
  document.body.append(settingsButton);
  settingsButton.focus();
  act(() => result.current.open());
  act(() => result.current.close());
  act(() => restore?.(0));
  expect(guard).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  settingsButton.remove();
  trigger.remove();
});
