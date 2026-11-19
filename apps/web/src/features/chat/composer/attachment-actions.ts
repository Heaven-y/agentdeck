import { ATTACHMENT_LIMITS, type ChatAttachment, type NativeInteractionFeatures } from '@agentdeck/shared/conversation';
import type { ChatIdentity } from '../../../lib/ws';
import type { ChatState, ConversationView } from '../state/chat-state';
import { conversationById, conversationViews, updateConversation } from '../state/conversations';
import { conversationPermission, conversationPermissionError, permissionPending } from '../state/chat-permission';
import { attachmentApi } from './attachment-api';
type DraftAttachmentScope = Pick<ConversationView, 'workspaceId' | 'agent' | 'conversationId' | 'sessionId'>;
export type DraftAttachment = {
  id: string;
  name: string;
  file: File;
  asset?: ChatAttachment;
  assetOwner?: ChatIdentity;
  assetScope?: DraftAttachmentScope;
  error?: string;
};
type SetState = (patch: Partial<ChatState>) => void;
export function attachmentBlocked(view: Pick<ConversationView, 'draftAttachments' | 'attachmentsBusy'>): boolean {
  return view.attachmentsBusy || view.draftAttachments.some((item) => !item.asset || !!item.error);
}
export function preserveAttachmentInput(view: ConversationView, uncertain = false): Partial<ConversationView> {
  const saved = view.pendingAttachmentInput;
  if (!saved || saved.rejected) return {};
  return view.draft || view.draftAttachments.length
    ? { pendingAttachmentInput: { ...saved, rejected: true, uncertain } }
    : { draft: saved.text, draftAttachments: saved.attachments, pendingAttachmentInput: undefined };
}
const sameOwner = (left: ChatIdentity, right: ChatIdentity) =>
  left.token === right.token && left.instanceId === right.instanceId;
function attachmentScope(view: DraftAttachmentScope): DraftAttachmentScope {
  const { workspaceId, agent, conversationId, sessionId } = view;
  return { workspaceId, agent, conversationId, sessionId };
}
function sameScope(left: DraftAttachmentScope, right: DraftAttachmentScope) {
  if (left.workspaceId !== right.workspaceId || left.agent !== right.agent) return false;
  return left.sessionId
    ? left.sessionId === right.sessionId
    : left.conversationId === right.conversationId && !right.sessionId;
}
function attachmentForScope(item: DraftAttachment, view: DraftAttachmentScope): DraftAttachment {
  if (!item.asset || (item.assetScope && sameScope(item.assetScope, view))) return item;
  return {
    ...item,
    asset: undefined,
    assetOwner: undefined,
    assetScope: undefined,
    error: '会话归属已变化，请重试上传。',
  };
}
function restriction(features: NativeInteractionFeatures, image: boolean): string | undefined {
  const feature = image ? features.images : features.documents;
  return feature.available ? undefined : (feature.reason ?? '当前模型或运行通道不支持此附件。');
}
function budget(view: ConversationView, files: File[], state: ChatState): string | undefined {
  const all = [...view.draftAttachments.map((item) => item.file), ...files];
  if (all.length > ATTACHMENT_LIMITS.count) return '每条消息最多8个附件。';
  if (all.filter((file) => file.type.startsWith('image/')).length > ATTACHMENT_LIMITS.images)
    return '每条消息最多4张图片。';
  if (all.some((file) => file.size > ATTACHMENT_LIMITS.fileBytes || !file.size))
    return '附件不能是空文件，每个文件最多5 MiB。';
  if (all.reduce((bytes, file) => bytes + file.size, 0) > ATTACHMENT_LIMITS.messageBytes)
    return '每条消息附件总计最多20 MiB。';
  const retained = new Set(
    [
      ...conversationViews(state).flatMap((view) => [
        ...view.draftAttachments,
        ...(view.pendingAttachmentInput?.attachments ?? []),
        ...view.draftBackups.flatMap((backup) => backup.attachments),
      ]),
      ...Object.values(state.followups).flatMap((queue) =>
        Object.values(queue.drafts).flatMap((draft) => draft.attachments),
      ),
    ].map((item) => item.file),
  );
  for (const file of files) retained.add(file);
  if ([...retained].reduce((bytes, file) => bytes + file.size, 0) > ATTACHMENT_LIMITS.cacheBytes)
    return '未发送附件已达到页面容量上限，请先移除一些附件。';
}
export function createAttachmentActions(get: () => ChatState, set: SetState, identity: () => ChatIdentity | undefined) {
  const uploads = new Map<string, AbortController>();
  let generation = 0;
  let knownOwner: ChatIdentity | undefined;
  function update(id: string, change: (view: ConversationView) => Partial<ConversationView>) {
    const view = conversationById(get(), id);
    if (view) set(updateConversation(get(), view, change(view)));
  }
  function invalidateAttachmentIdentity() {
    generation++;
    for (const controller of uploads.values()) controller.abort();
    uploads.clear();
    knownOwner = undefined;
    const clear = (item: DraftAttachment): DraftAttachment => ({
      ...item,
      asset: undefined,
      assetOwner: undefined,
      assetScope: undefined,
      error: '页面连接身份已变化，请重试上传。',
    });
    for (const view of conversationViews(get())) {
      update(view.conversationId, (current) => ({
        attachmentsBusy: false,
        draftAttachments: current.draftAttachments.map(clear),
        pendingAttachmentInput: current.pendingAttachmentInput
          ? { ...current.pendingAttachmentInput, attachments: current.pendingAttachmentInput.attachments.map(clear) }
          : undefined,
        draftBackups: current.draftBackups.map((backup) => ({ ...backup, attachments: backup.attachments.map(clear) })),
      }));
    }
    set({
      followups: Object.fromEntries(
        Object.entries(get().followups).map(([id, queue]) => [
          id,
          {
            ...queue,
            invalid: true,
            error: '连接身份已变化，请核对历史后恢复草稿，不会自动重发。',
            drafts: Object.fromEntries(
              Object.entries(queue.drafts).map(([key, draft]) => [
                key,
                { ...draft, attachments: draft.attachments.map(clear) },
              ]),
            ),
          },
        ]),
      ),
    });
  }
  function syncAttachmentScopes() {
    for (const view of conversationViews(get())) {
      const draftAttachments = view.draftAttachments.map((item) => attachmentForScope(item, view));
      const saved = view.pendingAttachmentInput;
      const pendingAttachmentInput = saved
        ? { ...saved, attachments: saved.attachments.map((item) => attachmentForScope(item, view)) }
        : undefined;
      const draftBackups = view.draftBackups.map((backup) => ({
        ...backup,
        attachments: backup.attachments.map((item) => attachmentForScope(item, view)),
      }));
      const draftChanged = draftAttachments.some((item, index) => item !== view.draftAttachments[index]);
      const savedChanged = saved?.attachments.some(
        (item, index) => item !== pendingAttachmentInput?.attachments[index],
      );
      if (
        draftChanged ||
        savedChanged ||
        draftBackups.some((backup, index) =>
          backup.attachments.some((item, position) => item !== view.draftBackups[index]?.attachments[position]),
        )
      )
        update(view.conversationId, () => ({ draftAttachments, pendingAttachmentInput, draftBackups }));
    }
  }
  function syncAttachmentIdentity() {
    syncAttachmentScopes();
    const owner = identity();
    if (!owner) return;
    const stale =
      conversationViews(get()).some((view) =>
        [
          ...view.draftAttachments,
          ...(view.pendingAttachmentInput?.attachments ?? []),
          ...view.draftBackups.flatMap((backup) => backup.attachments),
        ].some((item) => item.asset && (!item.assetOwner || !sameOwner(item.assetOwner, owner))),
      ) ||
      Object.values(get().followups).some((queue) =>
        Object.values(queue.drafts).some((draft) =>
          draft.attachments.some((item) => item.asset && (!item.assetOwner || !sameOwner(item.assetOwner, owner))),
        ),
      );
    if ((knownOwner && !sameOwner(knownOwner, owner)) || stale) invalidateAttachmentIdentity();
    knownOwner = { ...owner };
  }
  function currentUpload(owner: ChatIdentity, startedGeneration: number) {
    const current = identity();
    // 短暂重连时身份暂不可用；只有明确失效或身份变更才废弃上传结果。
    return generation === startedGeneration && (!current || sameOwner(current, owner));
  }
  async function verifyUpload(view: ConversationView, owner: ChatIdentity, file: File, asset: ChatAttachment) {
    if (asset.kind !== 'image') return;
    try {
      await attachmentApi.verifyImage(file);
    } catch (error) {
      await attachmentApi.remove(view, owner, asset).catch(() => undefined);
      throw error;
    }
  }
  type UploadContext = {
    view: ConversationView;
    owner: ChatIdentity;
    features: NativeInteractionFeatures;
    startedGeneration: number;
  };
  function retainsDraft(view: ConversationView, item: DraftAttachment) {
    return conversationById(get(), view.conversationId)?.draftAttachments.some((entry) => entry.id === item.id);
  }
  function discardedUpload(context: UploadContext, item: DraftAttachment, signal: AbortSignal) {
    return (
      signal.aborted || !currentUpload(context.owner, context.startedGeneration) || !retainsDraft(context.view, item)
    );
  }
  async function uploadOne(context: UploadContext, item: DraftAttachment) {
    const { view, owner, features, startedGeneration } = context;
    if (!retainsDraft(view, item)) return;
    const controller = new AbortController();
    uploads.set(item.id, controller);
    try {
      const reason = restriction(features, item.file.type.startsWith('image/'));
      if (reason) throw new Error(reason);
      // 记录实际上传请求的归属，迟到响应不能借用当前视图的新 session。
      const assetScope = attachmentScope(view);
      const asset = await attachmentApi.upload(view, owner, item.file, controller.signal);
      await verifyUpload(view, owner, item.file, asset);
      if (discardedUpload(context, item, controller.signal)) {
        await attachmentApi.remove(view, owner, asset).catch(() => undefined);
        syncAttachmentIdentity();
        return;
      }
      const verified = restriction(features, asset.kind === 'image');
      if (verified) {
        await attachmentApi.remove(view, owner, asset).catch(() => undefined);
        throw new Error(verified);
      }
      update(view.conversationId, (current) => ({
        draftAttachments: current.draftAttachments.map((entry) =>
          entry.id === item.id ? { ...entry, asset, assetOwner: { ...owner }, assetScope, error: undefined } : entry,
        ),
      }));
    } catch (error) {
      if (controller.signal.aborted || !currentUpload(owner, startedGeneration)) return;
      update(view.conversationId, (current) => ({
        draftAttachments: current.draftAttachments.map((entry) =>
          entry.id === item.id ? { ...entry, error: error instanceof Error ? error.message : '附件上传失败。' } : entry,
        ),
      }));
    } finally {
      if (uploads.get(item.id) === controller) uploads.delete(item.id);
    }
  }
  function mayBeImage(file: File): boolean {
    return !file.type || file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name);
  }
  async function uploadDraft(view: ConversationView, owner: ChatIdentity, startedGeneration: number) {
    const includesImages = view.draftAttachments.some((item) => !item.asset && mayBeImage(item.file));
    const features = await attachmentApi.features(view, owner, includesImages);
    for (const item of view.draftAttachments) {
      if (!currentUpload(owner, startedGeneration)) return;
      if (!item.asset) await uploadOne({ view, owner, features, startedGeneration }, item);
    }
  }
  async function process(id: string) {
    syncAttachmentIdentity();
    const state = get();
    const view = conversationById(state, id);
    const owner = identity();
    if (!view || !owner || view.attachmentsBusy) return;
    if (permissionPending(state, view) || conversationPermissionError(state, view)) return;
    const startedGeneration = generation;
    update(id, () => ({ attachmentsBusy: true }));
    try {
      await uploadDraft({ ...view, permission: conversationPermission(state, view) }, owner, startedGeneration);
    } catch (error) {
      if (!currentUpload(owner, startedGeneration)) return;
      update(id, (current) => ({
        draftAttachments: current.draftAttachments.map((item) =>
          item.asset ? item : { ...item, error: error instanceof Error ? error.message : '无法检查附件能力。' },
        ),
      }));
    } finally {
      syncAttachmentIdentity();
      if (generation === startedGeneration) update(id, () => ({ attachmentsBusy: false }));
    }
  }
  return {
    attachmentIdentity: identity,
    invalidateAttachmentIdentity,
    syncAttachmentIdentity,
    async addAttachments(files: File[]) {
      const state = get();
      if (!files.length || !state.workspaceId || state.attachmentsBusy) return;
      if (!identity()) {
        set({ banner: '请等待连接恢复后添加附件。' });
        return;
      }
      const reason = budget(state, files, state);
      if (reason) {
        set({ banner: reason });
        return;
      }
      const id = state.conversationId;
      update(id, (view) => ({
        draftAttachments: [
          ...view.draftAttachments,
          ...files.map((file) => ({ id: crypto.randomUUID(), name: file.name, file })),
        ],
      }));
      await process(id);
    },
    retryAttachments: () => process(get().conversationId),
    removeAttachment(id: string) {
      uploads.get(id)?.abort();
      const view = get(),
        owner = identity();
      const item = view.draftAttachments.find((item) => item.id === id);
      update(view.conversationId, (current) => ({
        draftAttachments: current.draftAttachments.filter((item) => item.id !== id),
      }));
      if (item?.asset && owner && item.assetOwner && sameOwner(item.assetOwner, owner))
        void attachmentApi.remove(view, owner, item.asset).catch(() => undefined);
    },
    attachmentPreviewFailed(id: string) {
      update(get().conversationId, (view) => ({
        draftAttachments: view.draftAttachments.map((item) =>
          item.id === id ? { ...item, error: '图片无法解码，请移除后重新选择。' } : item,
        ),
      }));
    },
    restoreAttachmentInput() {
      syncAttachmentIdentity();
      const current = get(),
        saved = current.pendingAttachmentInput;
      if (!saved?.rejected || current.attachmentsBusy) return;
      set({
        draft: saved.text,
        draftAttachments: saved.attachments,
        pendingAttachmentInput:
          current.draft || current.draftAttachments.length
            ? { text: current.draft, attachments: current.draftAttachments, rejected: true }
            : undefined,
      });
    },
    discardAttachmentInput() {
      set({ pendingAttachmentInput: undefined });
    },
  };
}
