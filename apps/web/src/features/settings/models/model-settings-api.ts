import { request } from '../../../lib/http';
import type { AgentCapabilities, AgentKind } from '@agentdeck/shared/conversation';
import type {
  NativeContextWindow,
  NativeModelSettingsDocument,
  NativeModelSettingsInput,
  ModelSecretInput,
  SecretValue,
} from '@agentdeck/shared/settings';

export const modelSettingsApi = {
  readSecret: (agent: AgentKind, input: ModelSecretInput, signal?: AbortSignal) =>
    request<SecretValue>(`/api/settings/models/${agent}/secret`, {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
      cache: 'no-store',
    }),
  contextWindow: (agent: AgentKind, model?: string, signal?: AbortSignal) =>
    request<NativeContextWindow>(
      `/api/settings/models/${agent}/context-window${model ? `?${new URLSearchParams({ model })}` : ''}`,
      { signal, cache: 'no-store' },
    ),
  catalog: (agent: AgentKind, signal?: AbortSignal) =>
    request<AgentCapabilities>(`/api/settings/models/${agent}/catalog`, { signal, cache: 'no-store' }),
  refreshCatalog: (agent: AgentKind, signal?: AbortSignal) =>
    request<AgentCapabilities>(`/api/settings/models/${agent}/catalog`, {
      method: 'POST',
      signal,
      cache: 'no-store',
    }),
  read: (agent: AgentKind, signal?: AbortSignal) =>
    request<NativeModelSettingsDocument>(`/api/settings/models/${agent}`, { signal, cache: 'no-store' }),
  save: (agent: AgentKind, input: NativeModelSettingsInput, signal?: AbortSignal) =>
    request<NativeModelSettingsDocument>(`/api/settings/models/${agent}`, {
      method: 'PUT',
      body: JSON.stringify(input),
      signal,
      cache: 'no-store',
    }),
};
