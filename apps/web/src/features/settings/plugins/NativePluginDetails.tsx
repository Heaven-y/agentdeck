import { useEffect, useState, type ReactNode } from 'react';
import type {
  NativeManagementContext,
  NativePluginEntry,
  NativePluginOption,
  NativePluginPrepareInput,
} from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../../ui/styles';
import { nativePluginsApi } from './native-plugins-api';
import { confirmNativeDiscard, nativeSettingsError } from '../resources/native-resource-labels';
import { useSettingsLeave } from '../navigation/settings-navigation';
import { ResourceDetails } from '../resources/ResourceList';
import { pluginScopeLabel } from './NativePluginOperation';
export function NativePluginDetails({
  context,
  entry,
  busy,
  onPrepare,
  onClose,
  children,
}: {
  context: NativeManagementContext;
  entry: NativePluginEntry;
  busy: boolean;
  onPrepare(input: NativePluginPrepareInput): void;
  onClose(): void;
  children?: ReactNode;
}) {
  const { agent, projectId } = context;
  const [options, setOptions] = useState<NativePluginOption[]>();
  const [configurationRevision, setConfigurationRevision] = useState<string>();
  const [error, setError] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const dirty = Object.values(values).some(Boolean);
  const leave = (action: () => void) => {
    if (confirmNativeDiscard(dirty)) action();
  };
  useSettingsLeave(leave, dirty);
  useEffect(() => {
    let current = true;
    void nativePluginsApi
      .detail({ agent, projectId }, entry)
      .then((value) => {
        if (current) {
          setOptions(value.options);
          setConfigurationRevision(value.configurationRevision);
        }
      })
      .catch((error) => {
        if (current) setError(nativeSettingsError(error));
      });
    return () => {
      current = false;
    };
  }, [agent, projectId, entry]);
  return (
    <ResourceDetails title={entry.name} onBack={() => leave(onClose)}>
      <PluginIdentity entry={entry} />
      {children}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      {options === undefined && !error && <p role="status">正在读取插件详情…</p>}
      {!!options?.length && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onPrepare({
              action: 'configure',
              id: entry.id,
              revision: entry.revision,
              configurationRevision,
              values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '')),
            });
          }}
        >
          <p className="text-sm text-muted-foreground">留空可保留已保存的值。</p>
          {options.map((option) => (
            <div key={option.key} className="space-y-1">
              <label className="block text-sm" htmlFor={`plugin-option-${option.key}`}>
                {option.title}
                {option.required ? '（必填）' : ''} · {option.configured ? '已配置' : '未配置'}
              </label>
              <div className="flex gap-2">
                <input
                  id={`plugin-option-${option.key}`}
                  className={inputClass}
                  type={option.sensitive && !visible[option.key] ? 'password' : 'text'}
                  value={values[option.key] ?? ''}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => setValues((current) => ({ ...current, [option.key]: event.target.value }))}
                />
                {option.sensitive && (
                  <button
                    type="button"
                    className={`${buttonClass('outline')} shrink-0 whitespace-nowrap`}
                    aria-label={`${visible[option.key] ? '隐藏' : '显示'} ${option.title}`}
                    onClick={() => setVisible((current) => ({ ...current, [option.key]: !current[option.key] }))}
                  >
                    {visible[option.key] ? '隐藏' : '显示'}
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{option.description}</p>
            </div>
          ))}
          <button
            className={buttonClass('primary')}
            type="submit"
            disabled={busy || !Object.values(values).some(Boolean)}
          >
            预览配置
          </button>
        </form>
      )}
    </ResourceDetails>
  );
}

function PluginIdentity({ entry }: { entry: NativePluginEntry }) {
  const source = entry.selector !== entry.name ? entry.selector : entry.source;
  const metadata = [source, pluginScopeLabel(entry.scope)];
  if (entry.version) metadata.push(`版本 ${entry.version}`);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{metadata.join(' · ')}</p>
      {entry.description && <p className="whitespace-pre-wrap break-words text-sm">{entry.description}</p>}
      {entry.reason && <p className="text-sm text-muted-foreground">{entry.reason}</p>}
      {entry.components.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {entry.components.map((item) => (
            <li key={item} className="[overflow-wrap:anywhere]">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
