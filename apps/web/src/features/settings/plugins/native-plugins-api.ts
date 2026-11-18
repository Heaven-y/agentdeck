import type {
  NativeManagementContext,
  NativePluginCatalog,
  NativePluginEntry,
  NativePluginOption,
  NativePluginOperation,
  NativePluginPrepareInput,
  NativePluginStartInput,
} from '@agentdeck/shared/settings';
import { request } from '../../../lib/http';
const url = (c: NativeManagementContext, suffix = '') =>
  `/api/native-management/${c.agent}/plugins${suffix}${c.projectId ? `?${new URLSearchParams({ projectId: c.projectId })}` : ''}`;
const post = <T>(c: NativeManagementContext, suffix: string, input: unknown) =>
  request<T>(url(c, suffix), { method: 'POST', body: JSON.stringify(input), cache: 'no-store' });
export const nativePluginsApi = {
  read: (c: NativeManagementContext, signal?: AbortSignal) =>
    request<NativePluginCatalog>(url(c), { signal, cache: 'no-store' }),
  prepare: (c: NativeManagementContext, input: NativePluginPrepareInput) =>
    post<NativePluginOperation>(c, '/prepare', input),
  start: (c: NativeManagementContext, input: NativePluginStartInput) => post<NativePluginOperation>(c, '/start', input),
  operation: (c: NativeManagementContext, operationId: string) =>
    post<NativePluginOperation>(c, '/operation', { operationId }),
  cancel: (c: NativeManagementContext, operationId: string) =>
    post<NativePluginOperation>(c, '/cancel', { operationId }),
  detail: (c: NativeManagementContext, entry: NativePluginEntry) =>
    post<{ entry: NativePluginEntry; options: NativePluginOption[]; configurationRevision?: string }>(c, '/detail', {
      id: entry.id,
      revision: entry.revision,
    }),
};
