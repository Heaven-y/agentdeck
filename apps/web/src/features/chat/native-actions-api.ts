import type {
  NativeActionCatalog,
  NativeActionPreview,
  NativeActionResult,
  SessionRef,
} from '@agentdeck/shared/conversation';
import { request } from '../../lib/http';
const base = (workspaceId: string, session: SessionRef) =>
  `/api/projects/${encodeURIComponent(workspaceId)}/sessions/${session.agent}/${encodeURIComponent(session.sessionId)}/native-actions`;
export const nativeActionsApi = {
  catalog: (workspaceId: string, session: SessionRef, signal?: AbortSignal) =>
    request<NativeActionCatalog>(base(workspaceId, session), { signal, cache: 'no-store' }),
  preview: (workspaceId: string, session: SessionRef, catalog: NativeActionCatalog, pointId: string) =>
    request<NativeActionPreview>(`${base(workspaceId, session)}/preview`, {
      method: 'POST',
      body: JSON.stringify({ action: catalog.action, revision: catalog.revision, pointId }),
    }),
  execute: (workspaceId: string, session: SessionRef, token: string) =>
    request<NativeActionResult>(`${base(workspaceId, session)}/execute`, {
      method: 'POST',
      body: JSON.stringify({ token, confirmed: true }),
    }),
};
