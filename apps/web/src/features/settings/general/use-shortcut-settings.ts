import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProductSettingsDocument } from '@agentdeck/shared/settings';
import { shortcutActions, shortcutIds, useShortcuts, type ShortcutBindings } from '../../../app/navigation/shortcuts';
import { useProductSettings } from './use-product-settings';
import { settingsApi, settingsKeys } from '../api';

export function useShortcutSettings() {
  const query = useProductSettings();
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (bindings: ShortcutBindings) => {
      const document = client.getQueryData<ProductSettingsDocument>(settingsKeys.productSettings);
      if (!document) return Promise.reject(new Error('快捷键设置尚未读取，请稍后重试。'));
      const shortcuts = Object.fromEntries(
        shortcutIds.filter((id) => bindings[id] !== shortcutActions[id].initial).map((id) => [id, bindings[id]]),
      );
      return settingsApi.saveProductSettings({
        settings: { ...document.settings, shortcuts },
        revision: document.revision,
      });
    },
    onSuccess: (document) => {
      client.setQueryData(settingsKeys.productSettings, document);
    },
    onError: async () => {
      await query.refetch();
    },
  });
  const saved = query.data?.settings.shortcuts;
  useEffect(() => {
    if (!mutation.isPending) useShortcuts.getState().load(saved);
  }, [saved, mutation.isPending]);
  return {
    ready: !!query.data,
    busy: mutation.isPending,
    error: mutation.error?.message ?? query.error?.message,
    save: mutation.mutate,
    clearError: mutation.reset,
  };
}
