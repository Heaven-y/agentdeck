import { create } from 'zustand';
import type { KeyboardShortcutAction } from '@agentdeck/shared/settings';

export const shortcutActions = {
  search: { label: '搜索会话', initial: 'Mod+K' },
  newSession: { label: '新建会话', initial: 'Mod+N' },
  nextTab: { label: '下一个会话标签', initial: 'Ctrl+Tab' },
  previousTab: { label: '上一个会话标签', initial: 'Ctrl+Shift+Tab' },
  closeTab: { label: '关闭当前会话标签', initial: 'Mod+W' },
  focusComposer: { label: '聚焦输入框', initial: 'Mod+Shift+L' },
  settings: { label: '打开设置', initial: 'Mod+,' },
  sidebar: { label: '折叠或展开侧栏', initial: 'Mod+B' },
} as const satisfies Record<KeyboardShortcutAction, { label: string; initial: string }>;
export type ShortcutAction = keyof typeof shortcutActions;
export type ShortcutBindings = Record<ShortcutAction, string | null>;
export const shortcutIds = Object.keys(shortcutActions) as ShortcutAction[];
const modifiers = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];
export const isMacKeyboard = () => /Mac|iPhone|iPad/.test(navigator.platform);
const defaults = (): ShortcutBindings =>
  Object.fromEntries(shortcutIds.map((id) => [id, shortcutActions[id].initial])) as ShortcutBindings;

export function validBinding(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('+');
  const key = parts.pop() ?? '';
  const supported =
    /^(?:[A-Z0-9]|Tab|Enter|Space|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2]))$/.test(key) ||
    [',', '.', '/', ';', '[', ']', '\\', '-', '='].includes(key);
  return (
    supported &&
    parts.every((part) => modifiers.includes(part)) &&
    new Set(parts).size === parts.length &&
    (parts.some((part) => part !== 'Shift') || /^F\d+$/.test(key))
  );
}
function resolvedBinding(binding: string, mac = isMacKeyboard()) {
  const parts = binding.replace('Mod+', mac ? 'Meta+' : 'Ctrl+').split('+');
  const key = parts.pop();
  return [...parts.sort(), key].join('+');
}
export function shortcutLabel(binding: string | null) {
  return binding?.replace('Mod', isMacKeyboard() ? '⌘' : 'Ctrl').replace('Meta', '⌘') ?? '未设置';
}
/** 保留系统退出和原生编辑按键；工作台操作只占用自己的组合。 */
function reservedBinding(binding: string) {
  const resolved = resolvedBinding(binding);
  const native = [
    'Mod+A',
    'Mod+C',
    'Mod+V',
    'Mod+X',
    'Mod+Z',
    'Mod+Shift+Z',
    'Mod+Y',
    'Mod+Q',
    'Mod+M',
    'Mod+R',
    'Mod+Shift+R',
    'Mod+-',
    'Mod+=',
    'Mod+0',
    'Mod+Shift+I',
    'Alt+F4',
    'Meta+Space',
    'F5',
    'F11',
  ];
  if (isMacKeyboard()) native.push('Mod+Shift+W', 'Ctrl+Mod+F');
  return native.some((value) => resolvedBinding(value) === resolved);
}
function configured(saved?: Partial<ShortcutBindings>): ShortcutBindings {
  const initial = defaults();
  if (!saved) return initial;
  for (const id of shortcutIds) {
    const binding = saved[id];
    if (binding === null || (validBinding(binding) && !reservedBinding(binding))) initial[id] = binding;
  }
  const active = Object.values(initial)
    .filter((value) => value !== null)
    .map((value) => resolvedBinding(value));
  return new Set(active).size === active.length ? initial : defaults();
}
export const useShortcuts = create<{
  bindings: ShortcutBindings;
  bind(action: ShortcutAction, binding: string | null): string | undefined;
  reset(): void;
  load(saved?: Partial<ShortcutBindings>): void;
}>((set, get) => ({
  bindings: defaults(),
  bind(action, binding) {
    if (binding && (!validBinding(binding) || reservedBinding(binding)))
      return '这个组合由系统或编辑功能使用，请换一个。';
    const conflict =
      binding &&
      shortcutIds.find(
        (id) =>
          id !== action && get().bindings[id] && resolvedBinding(get().bindings[id]!) === resolvedBinding(binding),
      );
    if (conflict) return `已用于“${shortcutActions[conflict].label}”。`;
    const bindings = { ...get().bindings, [action]: binding };
    set({ bindings });
    return undefined;
  },
  reset() {
    const bindings = defaults();
    set({ bindings });
  },
  load(saved) {
    set({ bindings: configured(saved) });
  },
}));

export function eventBinding(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>) {
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const mac = isMacKeyboard();
  const parts: Array<[boolean, string]> = [
    [event.ctrlKey, mac ? 'Ctrl' : 'Mod'],
    [event.metaKey, mac ? 'Mod' : 'Meta'],
    [event.altKey, 'Alt'],
    [event.shiftKey, 'Shift'],
  ];
  const binding = [...parts.filter(([pressed]) => pressed).map(([, name]) => name), key].join('+');
  return validBinding(binding) ? binding : undefined;
}
export function shortcutAction(event: KeyboardEvent, bindings: ShortcutBindings): ShortcutAction | undefined {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return;
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (target?.closest('.xterm,[data-shortcut-recorder]') || document.querySelector('dialog:modal')) return;
  const pressed = eventBinding(event);
  if (!pressed) return;
  return shortcutIds.find((id) => bindings[id] && resolvedBinding(bindings[id]) === resolvedBinding(pressed));
}
