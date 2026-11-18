// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  guardSettingsNavigation,
  SettingsNavigationContext,
  useSettingsLeave,
  type SettingsNavigation,
} from '../../../../src/features/settings/navigation/settings-navigation';

afterEach(cleanup);
function Draft({ block }: { block: boolean }) {
  useSettingsLeave((action) => {
    if (!block) action();
  });
  return <input aria-label="配置草稿" defaultValue="" />;
}
it('多个活跃表单共同阻止离开，卸载旧上下文后不留下旧保护', () => {
  const guards: SettingsNavigation = new Map();
  const leave = vi.fn();
  const mounted = render(
    <SettingsNavigationContext.Provider value={guards}>
      <Draft block={false} />
      <Draft block />
    </SettingsNavigationContext.Provider>,
  );
  fireEvent.change(screen.getAllByLabelText('配置草稿')[0]!, { target: { value: '保留草稿' } });
  guardSettingsNavigation(guards, leave);
  expect(leave).not.toHaveBeenCalled();
  expect(screen.getAllByLabelText<HTMLInputElement>('配置草稿')[0]!.value).toBe('保留草稿');
  mounted.rerender(
    <SettingsNavigationContext.Provider value={guards}>
      <Draft block={false} />
    </SettingsNavigationContext.Provider>,
  );
  guardSettingsNavigation(guards, leave);
  expect(leave).toHaveBeenCalledOnce();
  mounted.unmount();
  expect(guards.size).toBe(0);
});
