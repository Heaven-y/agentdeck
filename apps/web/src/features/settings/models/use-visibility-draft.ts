import { useEffect, useRef, useState } from 'react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { ModelVisibilityKey, ProductSettingsDocument } from '@agentdeck/shared/settings';
import { queryClient } from '../../../lib/query-client';
import { useChat } from '../../chat/state/chat-store';
import { settingsApi, settingsKeys } from '../api';
import { nativeSettingsError } from '../resources/native-resource-labels';

/** “恢复全部”删除当前范围；显式空列表则只保留当前模型。 */
export type VisibilitySelection = string[] | 'all';
type Visibility = ProductSettingsDocument['settings']['modelVisibility'];
type Drafts = Partial<Record<ModelVisibilityKey, VisibilitySelection>>;
export type VisibilityDraftView = {
  selected: VisibilitySelection;
  dirty: boolean;
  ready: boolean;
  error: string;
  change(selection: VisibilitySelection): void;
  reload(): void;
};

function sameSelection(selection: VisibilitySelection, saved?: string[]) {
  if (selection === 'all') return saved === undefined;
  if (saved === undefined) return false;
  const next = new Set(selection);
  const current = new Set(saved);
  return next.size === current.size && [...next].every((id) => current.has(id));
}

function changedKeys(drafts: Drafts, saved: Visibility) {
  return (Object.keys(drafts) as ModelVisibilityKey[]).filter((key) => !sameSelection(drafts[key]!, saved?.[key]));
}

/** 草稿归属于编辑时的连接方式；保存或切换原生连接不能把草稿挪给新目录。 */
export function useVisibilityDraft(agent: AgentKind) {
  const [document, setDocument] = useState<ProductSettingsDocument>();
  const [drafts, setDrafts] = useState<Drafts>({});
  const [error, setError] = useState('');
  const [reloadCount, setReloadCount] = useState(0);
  const lock = useRef(false);
  const [saving, setSaving] = useState(false);
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
  }, [reloadCount, agent]);
  const saved = document?.settings.modelVisibility;
  const dirty = !!document && changedKeys(drafts, saved).length > 0;
  function reload() {
    if (lock.current) return;
    setDrafts({});
    setError('');
    setDocument(undefined);
    setReloadCount((value) => value + 1);
  }
  function range(key: ModelVisibilityKey | undefined): VisibilityDraftView {
    const selection = key ? drafts[key] : undefined;
    const savedSelection = key ? saved?.[key] : undefined;
    return {
      selected: selection ?? savedSelection ?? 'all',
      dirty: selection !== undefined && !sameSelection(selection, savedSelection),
      ready: Boolean(key && document && !saving),
      error,
      change(selection) {
        if (key && !lock.current) setDrafts((items) => ({ ...items, [key]: selection }));
      },
      reload,
    };
  }
  async function save() {
    if (lock.current) return false;
    if (!document || !dirty) return true;
    const modelVisibility = { ...saved };
    for (const key of changedKeys(drafts, saved)) {
      const selection = drafts[key];
      if (selection === 'all') delete modelVisibility[key];
      else modelVisibility[key] = selection;
    }
    lock.current = true;
    setSaving(true);
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
      setDrafts({});
      setError('');
      return true;
    } catch (reason) {
      setError(nativeSettingsError(reason));
      return false;
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return { dirty, saving, range, save, reload };
}
