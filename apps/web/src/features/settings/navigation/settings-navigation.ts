import { createContext, useContext, useLayoutEffect } from 'react';
export type SettingsLeave = (action: () => void) => void;

export const leaveSettings: SettingsLeave = (action) => action();
export type SettingsNavigation = Map<symbol, SettingsLeave>;
export const SettingsNavigationContext = createContext<SettingsNavigation | null>(null);
export function guardSettingsNavigation(guards: SettingsNavigation, action: () => void) {
  const pending = [...guards.values()];
  const next = (index: number) => {
    const guard = pending[index];
    if (guard) guard(() => next(index + 1));
    else action();
  };
  next(0);
}

export function useGuardedSettingsNavigation(fallback: SettingsLeave = leaveSettings): SettingsLeave {
  const guards = useContext(SettingsNavigationContext);
  return (action) => {
    if (guards) guardSettingsNavigation(guards, action);
    else fallback(action);
  };
}

/** 页面内的编辑视图接管统一离开保护，卸载后不留下旧上下文。 */
export function useSettingsLeave(leave: SettingsLeave, active = true) {
  const guards = useContext(SettingsNavigationContext);
  useLayoutEffect(() => {
    if (!guards || !active) return;
    const id = Symbol();
    guards.set(id, leave);
    return () => {
      guards.delete(id);
    };
  }, [guards, leave, active]);
}
