import { useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import {
  eventBinding,
  shortcutActions,
  shortcutIds,
  shortcutLabel,
  useShortcuts,
  type ShortcutAction,
} from '../../../app/navigation/shortcuts';
import { buttonClass, iconButtonClass, inputClass } from '../../../ui/styles';
import { useShortcutSettings } from './use-shortcut-settings';

export function KeyboardShortcutsPanel() {
  const { bindings, bind, reset } = useShortcuts();
  const settings = useShortcutSettings();
  const [recording, setRecording] = useState<ShortcutAction>();
  const [error, setError] = useState<{ action: ShortcutAction; message: string }>();
  function record(action: ShortcutAction, event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    event.preventDefault();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      setRecording(undefined);
      return;
    }
    const binding = eventBinding(event.nativeEvent);
    if (!binding) return;
    const message = bind(action, binding);
    setError(message ? { action, message } : undefined);
    if (!message) {
      setRecording(undefined);
      settings.save(useShortcuts.getState().bindings);
    }
  }
  return (
    <section aria-label="快捷键" className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-base font-medium">快捷键</h2>
        <p className="mt-1 text-sm text-muted-foreground">适用于所有工作区和 CLI。</p>
      </div>
      {settings.error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {settings.error}
        </p>
      )}
      {!settings.ready && !settings.error && (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取快捷键…
        </p>
      )}
      <div className="divide-y divide-border rounded-xl border border-border px-4">
        {shortcutIds.map((action) => (
          <div key={action} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-sm">{shortcutActions[action].label}</span>
            <div className="flex items-center gap-2">
              {recording === action ? (
                <input
                  autoFocus
                  readOnly
                  data-shortcut-recorder
                  aria-label={`设置${shortcutActions[action].label}快捷键`}
                  placeholder="按下快捷键"
                  onKeyDown={(event) => record(action, event)}
                  onBlur={() => setRecording(undefined)}
                  className={`${inputClass} w-40 text-center text-sm`}
                />
              ) : (
                <button
                  type="button"
                  disabled={!settings.ready || settings.busy}
                  className={`${buttonClass('outline')} min-w-40 justify-center`}
                  aria-label={`修改${shortcutActions[action].label}快捷键`}
                  onClick={() => {
                    setError(undefined);
                    settings.clearError();
                    setRecording(action);
                  }}
                >
                  <kbd className="font-sans text-xs">{shortcutLabel(bindings[action])}</kbd>
                </button>
              )}
              <button
                type="button"
                className={iconButtonClass}
                disabled={!bindings[action] || !settings.ready || settings.busy}
                aria-label={`停用${shortcutActions[action].label}快捷键`}
                title="停用快捷键"
                onClick={() => {
                  bind(action, null);
                  setError(undefined);
                  settings.save(useShortcuts.getState().bindings);
                }}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
            {error?.action === action && (
              <p role="alert" className="w-full text-sm text-destructive-foreground">
                {error.message}
              </p>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className={buttonClass('outline')}
        disabled={!settings.ready || settings.busy}
        onClick={() => {
          reset();
          setRecording(undefined);
          setError(undefined);
          settings.save(useShortcuts.getState().bindings);
        }}
      >
        恢复默认快捷键
      </button>
    </section>
  );
}
