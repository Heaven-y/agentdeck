import { useCallback, useEffect, useState } from 'react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { ProductSettingsDocument } from '@agentdeck/shared/settings';
import { queryClient } from '../../../lib/query-client';
import { useChat } from '../../chat/state/chat-store';
import { settingsApi, settingsKeys } from '../api';
import { nativeSettingsError } from '../resources/native-resource-labels';

/** 'all' 表示“恢复全部”：保存时删除该 CLI 的范围，后续目录新增型号仍会显示。 */
export type VisibilitySelection = string[] | 'all';

function sameSelection(selection: VisibilitySelection, saved?: string[]) {
  if (selection === 'all') return saved === undefined;
  const next = new Set(selection);
  const current = new Set(saved ?? []);
  return next.size === current.size && [...next].every((id) => current.has(id));
}

/**
 * 模型显示范围是设置页里的普通表单：勾选只改草稿，点“保存配置”才写入。
 * 逐次自动保存会在连续点击时丢改动，也会让迟到响应覆盖用户的最新选择。
 */
export function useVisibilityDraft(agent: AgentKind) {
  const [document, setDocument] = useState<ProductSettingsDocument>();
  const [draft, setDraft] = useState<VisibilitySelection>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void settingsApi
      .readProductSettings(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDocument(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(nativeSettingsError(reason));
      });
    return () => controller.abort();
  }, [reload, agent]);
  const saved = document?.settings.modelVisibility?.[agent];
  const selected: VisibilitySelection = draft ?? saved ?? 'all';
  const dirty = !!document && !sameSelection(selected, saved);
  const change = useCallback((selection: VisibilitySelection) => setDraft(selection), []);
  const save = useCallback(async () => {
    if (!document || !dirty) return true;
    const modelVisibility = { ...document.settings.modelVisibility };
    if (selected === 'all') delete modelVisibility[agent];
    else modelVisibility[agent] = selected;
    try {
      await settingsApi.saveProductSettings({
        revision: document.revision,
        settings: { ...document.settings, modelVisibility },
      });
      // 保存响应可能晚于其他窗口的修改；重读最新版本再作为新基准。
      await queryClient.cancelQueries({ queryKey: settingsKeys.productSettings });
      const result = await queryClient.fetchQuery({
        queryKey: settingsKeys.productSettings,
        queryFn: ({ signal }) => settingsApi.readProductSettings(signal),
        staleTime: 0,
      });
      useChat.getState().setDefaults(result.settings);
      setDocument(result);
      setDraft(undefined);
      setError('');
      return true;
    } catch (reason) {
      setError(nativeSettingsError(reason));
      return false;
    }
  }, [agent, dirty, document, selected]);
  return {
    selected,
    dirty,
    ready: !!document,
    error,
    change,
    save,
    reload() {
      setDraft(undefined);
      setError('');
      setDocument(undefined);
      setReload((value) => value + 1);
    },
  };
}
