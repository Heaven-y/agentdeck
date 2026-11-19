import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '../../../lib/query-client';
import { ApiError } from '../../../lib/http';
import { invalidateNativeCapabilities } from '../../../cli/shared/capability-cache';
import { buttonClass, inputClass } from '../../../ui/styles';
import { settingsApi } from '../api';
import { useSettingsLeave } from '../navigation/settings-navigation';
import { confirmNativeDiscard, nativeSettingsError } from '../resources/native-resource-labels';
import { antigravityAccountKey } from './model-settings-api';

const proxyKey = ['antigravity-proxy'] as const;

function useProxyAddress() {
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const proxy = useQuery(
    {
      queryKey: proxyKey,
      queryFn: ({ signal }) => settingsApi.readAntigravityProxy(signal),
      retry: false,
      gcTime: 0,
    },
    queryClient,
  );
  const changed = draft !== undefined && draft.trim() !== proxy.data?.address;
  useSettingsLeave((leave) => {
    if (!saving && confirmNativeDiscard(changed)) leave();
  }, changed || saving);
  const saveAddress = async () => {
    if (!proxy.data || draft === undefined || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const result = await settingsApi.saveAntigravityProxy({ revision: proxy.data.revision, address: draft.trim() });
      queryClient.setQueryData(proxyKey, result);
      setDraft(undefined);
      setSaved(true);
      void invalidateNativeCapabilities('antigravity').catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: antigravityAccountKey });
    } catch (error) {
      setSaveError(nativeSettingsError(error));
      if (error instanceof ApiError && error.code === 'revision_conflict') void proxy.refetch();
    } finally {
      setSaving(false);
    }
  };
  return {
    value: draft ?? proxy.data?.address ?? '',
    available: !!proxy.data,
    changed,
    saving,
    saved,
    error: saveError || (proxy.error ? nativeSettingsError(proxy.error) : ''),
    saveAddress,
    change(value: string) {
      setSaved(false);
      setSaveError('');
      setDraft(value);
    },
  };
}

export function AntigravityProxyField({ disabled }: { disabled: boolean }) {
  const id = useId();
  const state = useProxyAddress();
  const busy = disabled || state.saving;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium">
        AGY 代理地址
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          className={inputClass}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          placeholder="例如 http://my-server"
          value={state.value}
          disabled={busy || !state.available}
          onChange={(event) => state.change(event.currentTarget.value)}
        />
        <button
          type="button"
          className={`${buttonClass('outline')} shrink-0`}
          disabled={busy || !state.changed}
          onClick={() => void state.saveAddress()}
        >
          {state.saving ? '正在保存…' : '保存代理'}
        </button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">登录和对话用同一个代理，清空后保存可恢复默认。</p>
      {state.error && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-xs text-muted-foreground">
          代理已保存，下次启动 AGY 时生效。
        </p>
      )}
    </div>
  );
}
