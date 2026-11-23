import { useEffect, useEffectEvent } from 'react';
import { shortcutAction, useShortcuts, type ShortcutAction } from './shortcuts';
import { useShortcutSettings } from '../../features/settings/general/use-shortcut-settings';

export function useWorkbenchShortcuts(actions: Record<ShortcutAction, () => void>) {
  useShortcutSettings();
  const bindings = useShortcuts((state) => state.bindings);
  const dispatch = useEffectEvent((event: KeyboardEvent) => {
    const action = shortcutAction(event, bindings);
    if (!action) return;
    event.preventDefault();
    actions[action]();
  });
  useEffect(() => {
    document.addEventListener('keydown', dispatch);
    return () => document.removeEventListener('keydown', dispatch);
  }, []);
}
