import { request } from '../../lib/http';
import type {
  WorkbenchPluginBackendRequest,
  WorkbenchPluginBackendResponse,
  WorkbenchPluginHostRequest,
  WorkbenchPluginCatalog,
  WorkbenchPluginPage,
  WorkbenchPluginStorage,
} from '@agentdeck/shared/plugins';

const pluginUrl = (id: string) => `/api/plugins/${encodeURIComponent(id)}`;
export const pluginsKey = ['workbench-plugins'] as const;
export const pluginApi = {
  list: (signal?: AbortSignal) => request<WorkbenchPluginCatalog>('/api/plugins', { signal, cache: 'no-store' }),
  install: (directory: string, revision?: string) =>
    request<WorkbenchPluginCatalog>('/api/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ directory, revision }),
    }),
  backend: (id: string, input: WorkbenchPluginBackendRequest, signal?: AbortSignal) =>
    request<WorkbenchPluginBackendResponse>(`${pluginUrl(id)}/backend`, {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    }),
  host: (id: string, input: WorkbenchPluginHostRequest, signal?: AbortSignal) =>
    request<unknown>(`${pluginUrl(id)}/host`, { method: 'POST', body: JSON.stringify(input), signal }),
  setEnabled: (id: string, enabled: boolean, revision: string) =>
    request<WorkbenchPluginCatalog>(pluginUrl(id), { method: 'PUT', body: JSON.stringify({ enabled, revision }) }),
  remove: (id: string, revision: string) =>
    request<WorkbenchPluginCatalog>(pluginUrl(id), { method: 'DELETE', body: JSON.stringify({ revision }) }),
  page: (id: string, signal?: AbortSignal) =>
    request<WorkbenchPluginPage>(`${pluginUrl(id)}/page`, { signal, cache: 'no-store' }),
  storage: (id: string) => request<WorkbenchPluginStorage>(`${pluginUrl(id)}/storage`, { cache: 'no-store' }),
  saveStorage: (id: string, input: WorkbenchPluginStorage) =>
    request<WorkbenchPluginStorage>(`${pluginUrl(id)}/storage`, { method: 'PUT', body: JSON.stringify(input) }),
};
