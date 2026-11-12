import {
  ChatAttachmentSchema,
  type AttachmentRef,
  type NativeInteractionFeatures,
  type NativeMediaLocator,
} from '@agentdeck/shared/conversation';
import type { ChatIdentity } from '../../lib/ws';
import { ApiError } from '../../lib/http';
import type { ConversationView } from './chat-state';
type View = Pick<
  ConversationView,
  'workspaceId' | 'agent' | 'conversationId' | 'sessionId' | 'modelOverrides' | 'permission'
>;
export function attachmentQuery(view: View): URLSearchParams {
  const query = new URLSearchParams({ agent: view.agent, conversationId: view.conversationId });
  if (view.sessionId) query.set('sessionId', view.sessionId);
  return query;
}
async function call(url: string, identity: ChatIdentity, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, 'x-agentdeck-owner': identity.token, 'x-agentdeck-instance': identity.instanceId },
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
    throw new ApiError(response.status, error.message ?? '附件操作失败，请重试。', { code: error.code });
  }
  return response;
}
const base = (view: View) => `/api/workspaces/${encodeURIComponent(view.workspaceId ?? '')}`;
export const attachmentApi = {
  async verifyImage(file: File): Promise<void> {
    const url = URL.createObjectURL(file),
      image = new Image();
    try {
      image.src = url;
      await image.decode();
    } catch {
      throw new Error('图片无法解码，请移除后重新选择。');
    } finally {
      image.src = '';
      URL.revokeObjectURL(url);
    }
  },
  async features(view: View, identity: ChatIdentity): Promise<NativeInteractionFeatures> {
    const query = attachmentQuery(view);
    const model = view.modelOverrides[view.agent];
    if (model) query.set('model', model);
    if (view.permission) query.set('permissionMode', view.permission.mode);
    return (await (
      await call(`${base(view)}/chat-input-capabilities?${query}`, identity, { method: 'POST' })
    ).json()) as NativeInteractionFeatures;
  },
  async upload(view: View, identity: ChatIdentity, file: File, signal?: AbortSignal) {
    const query = attachmentQuery(view);
    query.set('name', file.name);
    query.set('mimeType', file.type || 'application/octet-stream');
    return ChatAttachmentSchema.parse(
      await (
        await call(`${base(view)}/chat-attachments?${query}`, identity, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
          signal,
        })
      ).json(),
    );
  },
  async preview(view: View, identity: ChatIdentity, ref: AttachmentRef, signal?: AbortSignal): Promise<Blob> {
    const query = attachmentQuery(view);
    query.set('revision', ref.revision);
    return (
      await call(`${base(view)}/chat-attachments/${encodeURIComponent(ref.id)}?${query}`, identity, { signal })
    ).blob();
  },
  async nativeMedia(view: View, locator: NativeMediaLocator, signal?: AbortSignal): Promise<Blob> {
    const query = new URLSearchParams({
      agent: view.agent,
      messageId: locator.messageId,
      index: String(locator.index),
      kind: locator.kind,
    });
    if (locator.subagentId) query.set('subagentId', locator.subagentId);
    const response = await fetch(`${base(view)}/sessions/${encodeURIComponent(locator.sessionId)}/media?${query}`, {
      signal,
    });
    if (!response.ok) throw new Error('这张原生图片当前不可读取。');
    return response.blob();
  },
  async remove(view: View, identity: ChatIdentity, ref: AttachmentRef): Promise<void> {
    const query = attachmentQuery(view);
    query.set('revision', ref.revision);
    await call(`${base(view)}/chat-attachments/${encodeURIComponent(ref.id)}?${query}`, identity, { method: 'DELETE' });
  },
};
