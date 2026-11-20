import {
  FollowupContentSchema,
  FOLLOWUP_LIMITS,
  type ClientMessage,
  type FollowupMode,
} from '@agentdeck/shared/conversation';
import type { ChatState } from '../state/chat-state';
import type { ChatSocket } from '../../../lib/ws';
import { attachmentBlocked } from '../composer/attachment-actions';
import {
  canReturnToDraft,
  canSteerQueued,
  draftContent,
  followupView,
  pendingFollowups,
  restoreDraft,
  steerAvailable,
  viewQueue,
  type FollowupDraft,
  type DraftBackup,
  type LocalFollowupQueue,
} from './followup-state';
import { selectionRestriction } from '../controls/capability-selection';
import { updateConversation } from '../state/conversations';
import { conversationPermission, conversationPermissionError, permissionPending } from '../state/chat-permission';
import { openedTab } from '../tabs/conversation-tabs';
type Set = (patch: Partial<ChatState>) => void;
export function createFollowupActions(get: () => ChatState, set: Set, send: ChatSocket['send']) {
  function action(message: ClientMessage) {
    if (get().connection !== 'open' || !send(message)) {
      set({ banner: '连接已断开，操作未发送。' });
      return false;
    }
    return true;
  }
  function entry(queueId: string, id: string) {
    const queue = get().followups[queueId];
    if (!queue || queue.invalid) return;
    const item = queue.snapshot.items.find((item) => item.clientMessageId === id);
    return item ? { queue, item } : undefined;
  }
  return {
    sendFollowup(text: string, mode: FollowupMode) {
      const state = get(),
        queue = viewQueue(state);
      const reason = followupRestriction(state, text, mode);
      if (reason || !queue) {
        set({ banner: reason ?? '正在准备待发列表，请保留草稿稍候。' });
        return false;
      }
      const content = draftContent({ ...state, permission: conversationPermission(state) }, text),
        clientMessageId = crypto.randomUUID();
      if (!FollowupContentSchema.safeParse(content).success) {
        set({ banner: '追加消息过大或格式不正确。' });
        return false;
      }
      if (
        !action({
          type: 'chat.followup',
          queueId: queue.snapshot.queueId,
          clientMessageId,
          mode,
          content,
          ...(mode === 'steer' ? { turnId: state.turnId } : {}),
        })
      )
        return false;
      const draft: FollowupDraft = {
        id: clientMessageId,
        text,
        attachments: state.draftAttachments,
        selection: state.selectedCapability,
        content,
      };
      set({
        followups: {
          ...get().followups,
          [queue.snapshot.queueId]: { ...queue, drafts: { ...queue.drafts, [clientMessageId]: draft } },
        },
        tabIds: openedTab(state.tabIds, state.conversationId),
        banner: undefined,
      });
      return true;
    },
    editFollowup(queueId: string, id: string) {
      const state = get();
      const found = entry(queueId, id);
      if (
        !found ||
        found.queue.returning ||
        viewQueue(state) !== found.queue ||
        !canReturnToDraft(found.item, found.queue) ||
        state.attachmentsBusy
      )
        return false;
      const backup = restoreEntry(found.queue, id, state.selectedCapability);
      if (!backup) return false;
      const blocked = recoveryBlocked(backup);
      if (blocked) {
        set({ banner: blocked });
        return false;
      }
      const revision = found.item.revision;
      if (!action({ type: 'followup.cancel', queueId, clientMessageId: id, revision, returnToDraft: true }))
        return false;
      set({
        followups: {
          ...state.followups,
          [queueId]: { ...found.queue, returning: { clientMessageId: id, revision, backup } },
        },
      });
      return true;
    },
    steerFollowup(queueId: string, id: string) {
      const state = get();
      const found = entry(queueId, id);
      return (
        !!state.turnId &&
        !!found &&
        viewQueue(state) === found.queue &&
        !found.queue.returning &&
        canSteerQueued(state, found.item, found.queue) &&
        action({
          type: 'followup.steer',
          queueId,
          clientMessageId: id,
          revision: found.item.revision,
          turnId: state.turnId,
        })
      );
    },
    cancelFollowup(queueId: string, id: string) {
      const found = entry(queueId, id);
      return (
        !!found && action({ type: 'followup.cancel', queueId, clientMessageId: id, revision: found.item.revision })
      );
    },
    clearFollowups(queueId: string) {
      return (
        !!get().followups[queueId] && !get().followups[queueId]!.invalid && action({ type: 'followup.clear', queueId })
      );
    },
    resumeFollowups(queueId: string) {
      const queue = get().followups[queueId];
      return (
        !!queue &&
        !queue.invalid &&
        !queue.snapshot.items.some((item) => ['unknown', 'failed', 'dispatching'].includes(item.status)) &&
        action({ type: 'followup.resume', queueId })
      );
    },
    restoreFollowup(queueId: string, id: string) {
      const state = get(),
        queue = state.followups[queueId];
      if (!queue) return;
      const blocked = restoreRestriction(queue, id);
      if (blocked) {
        set({ banner: blocked });
        return;
      }
      const view = followupView(state, queue.snapshot);
      const backup = restoreEntry(queue, id, view?.selectedCapability);
      if (!backup || !view || view.attachmentsBusy) return;
      const reason = recoveryBlocked(backup);
      if (reason) {
        set({ banner: reason });
        return;
      }
      set(updateConversation(state, view, restoreDraft(view, backup)));
      state.openConversation(view.conversationId);
    },
    discardFollowupBackup(queueId: string, id: string) {
      const state = get(),
        queue = state.followups[queueId];
      if (
        !queue ||
        (!queue.invalid &&
          queue.snapshot.items.some(
            (item) => item.clientMessageId === id && !['accepted', 'cancelled'].includes(item.status),
          ))
      )
        return;
      const drafts = { ...queue.drafts };
      delete drafts[id];
      set({ followups: { ...state.followups, [queueId]: { ...queue, drafts } } });
    },
    restoreDraftBackup(id: string) {
      const state = get(),
        backup = state.draftBackups.find((entry) => entry.id === id);
      if (!backup || state.attachmentsBusy) return;
      set({
        ...restoreDraft({ ...state, draftBackups: state.draftBackups.filter((entry) => entry.id !== id) }, backup),
      });
    },
    discardDraftBackup(id: string) {
      set({ draftBackups: get().draftBackups.filter((entry) => entry.id !== id) });
    },
  };
}
function restoreRestriction(queue: LocalFollowupQueue, id: string) {
  if (queue.invalid) return;
  const item = queue.snapshot.items.find((item) => item.clientMessageId === id);
  if (item && ['queued', 'dispatching', 'accepted'].includes(item.status))
    return '该消息仍在列表或已受理，请使用列表编辑；不要重复发送。';
  if (!item && !queue.drafts[id]?.error) return '仍在等待追加消息回执，请核对列表后再恢复。';
}
function restoreEntry(queue: LocalFollowupQueue, id: string, selected?: DraftBackup['selection']) {
  const local = queue.drafts[id],
    item = queue.snapshot.items.find((item) => item.clientMessageId === id);
  const content = local?.content ?? item?.content;
  if (!content) return;
  const attachments = local?.attachments ?? [];
  return {
    content,
    id: crypto.randomUUID(),
    text: content.text,
    attachments,
    selection: restoredSelection(content.selection?.id, local, selected),
    missingFiles: !!content.attachments?.length && !attachments.length,
  };
}
function recoveryBlocked(backup: NonNullable<ReturnType<typeof restoreEntry>>) {
  if (backup.content.selection && !backup.selection) return `请重新选择原生命令 /${backup.content.selection.id}。`;
  if (backup.missingFiles) return '当前页面没有原文件备份，无法取回附件。';
}
function restoredSelection(id: string | undefined, local?: FollowupDraft, selected?: DraftBackup['selection']) {
  return local?.selection ?? (selected?.id === id ? selected : undefined);
}
function followupCapacity(queue: LocalFollowupQueue) {
  const pending = Object.values(queue.drafts).filter((draft) => !draft.acknowledged && !draft.error);
  if (pending.length) return '正在等待上一条追加消息回执，请保留当前草稿。';
  const localOnly = Object.values(queue.drafts).filter(
    (draft) => !queue.snapshot.items.some((item) => item.clientMessageId === draft.id),
  );
  if (pendingFollowups(queue).length + localOnly.length >= FOLLOWUP_LIMITS.perConversation)
    return '待发列表已满，最多10条，请先处理待发记录或本页备份。';
}
export function followupRestriction(state: ChatState, text: string, mode: FollowupMode) {
  if (
    [
      state.loadingHistory,
      state.historyError,
      permissionPending(state),
      conversationPermissionError(state),
      managementBusy(state),
      attachmentBlocked(state),
    ].some(Boolean)
  )
    return '请先完成历史、权限或附件准备。';
  if (!text.trim() && !state.selectedCapability && !state.draftAttachments.length) return '请输入内容或选择附件。';
  const queue = viewQueue(state);
  if (!queue || queue.invalid) return '正在准备待发列表或连接身份已失效，请保留草稿。';
  const capacity = followupCapacity(queue);
  if (capacity) return capacity;
  if (mode === 'steer' && !steerAvailable(state)) return '当前不能引导本轮，请核对运行状态和本轮模型、强度及权限。';
  return selectionRestriction(state.selectedCapability, state.sessionId, text);
}
function managementBusy(state: ChatState) {
  return (
    state.workspaceId &&
    state.sessionId &&
    state.sessionOperations[JSON.stringify([state.workspaceId, state.agent, state.sessionId])]?.pending
  );
}
