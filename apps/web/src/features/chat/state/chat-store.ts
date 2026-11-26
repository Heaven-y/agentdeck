import type { ChatState } from './chat-state';
import { markPluginInputSent, previousPluginInput } from './plugin-input-receipts';
import type { SessionRef, SessionActionInput } from '@agentdeck/shared/conversation';
import { InteractionAnswerSchema } from '@agentdeck/shared/conversation';
import {
  DEFAULT_REASONING_EFFORTS,
  EMPTY_MODEL_OVERRIDES,
  sameSession,
  sessionActionKey,
  emptyConversation,
} from './chat-state-helpers';
import { sessionsApi } from '../../sessions/api';
// 会话身份包含 Agent；历史请求与实时轮次分别校验选择代次和关联 ID。
import { create } from 'zustand';

import { refreshSessionLists } from '../../sessions/queries/session-queries';
import { connectChat, type ChatSocket } from '../../../lib/ws';
import { markPermissionPending, reduceChat } from '../../conversation/model/conversation-events';
import { capabilityRestriction, selectionRestriction } from '../controls/capability-selection';
import { createChatEvents } from './chat-events';
import { createChatHistory } from './chat-history';
import { createAttachmentActions, attachmentBlocked } from '../composer/attachment-actions';
import { createFollowupActions } from '../followups/followup-actions';
import { draftContent, pendingFollowups, viewQueue } from '../followups/followup-state';
import { createAsyncQuestionActions } from '../interactions/async-question-actions';
import {
  conversationPermission,
  conversationPermissionError,
  emptyPermissionDefaults,
  permissionEditorPending,
  permissionPending,
  readPermissionDefaults,
  saveConversationPermission,
} from './chat-permission';
import { createConversationTabs, existingTabs, openedTab } from '../tabs/conversation-tabs';
import {
  conversationBusy,
  conversationById,
  conversationForSession,
  retainConversation,
  sessionIsRunning,
  updateConversation,
  needsHistory,
} from './conversations';

const LAST_WORKSPACE_KEY = 'agentdeck.lastProject';
export { sessionActionKey } from './chat-state-helpers';

let socket: ChatSocket | undefined;
const pendingInterrupts = new Set<string>();
export function managementPending(current: ChatState): boolean {
  if (!current.workspaceId || !current.sessionId) return false;
  return (
    current.sessionOperations[
      sessionActionKey(current.workspaceId, { agent: current.agent, sessionId: current.sessionId })
    ]?.pending === true
  );
}
function cannotSend(current: ChatState, text: string): boolean {
  const empty = !text.trim() && !current.selectedCapability && !current.draftAttachments.length;
  return [
    conversationBusy(current),
    current.loadingHistory,
    permissionPending(current),
    conversationPermissionError(current),
    current.historyError,
    empty,
    attachmentBlocked(current),
    managementPending(current),
  ].some(Boolean);
}
function canStart(current: ChatState, text: string): current is ChatState & { workspaceId: string } {
  return !!current.workspaceId && !cannotSend(current, text);
}
function shouldQueue(current: ChatState) {
  const queue = viewQueue(current);
  return conversationBusy(current) || (!queue?.invalid && pendingFollowups(queue).length > 0);
}
function sendRestriction(current: ChatState, text: string): string | undefined {
  if (current.draftAttachments.length && current.pendingAttachmentInput?.rejected)
    return '请先恢复或放弃暂存输入，再发送新的附件消息。';
  return selectionRestriction(current.selectedCapability, current.sessionId, text);
}
function sentAttachmentInput(current: ChatState, text: string): ChatState['pendingAttachmentInput'] {
  if (current.draftAttachments.length) return { text, attachments: current.draftAttachments };
  return current.pendingAttachmentInput?.rejected ? current.pendingAttachmentInput : undefined;
}
function sendMessagePayload(current: ChatState & { workspaceId: string }, text: string, clientTurnId: string) {
  return {
    type: 'chat.send' as const,
    workspaceId: current.workspaceId,
    agent: current.agent,
    sessionId: current.sessionId,
    text,
    ...attachmentRefs(current),
    ...(current.selectedCapability ? { selection: { id: current.selectedCapability.id } } : {}),
    model: current.modelOverrides[current.agent].trim() || undefined,
    reasoningEffort: current.reasoningEfforts[current.agent].trim() || undefined,
    collaborationMode: current.agent === 'codex' ? current.collaborationMode : undefined,
    ...(current.permission ? { permission: current.permission } : {}),
    clientTurnId,
    conversationId: current.conversationId,
  };
}
function renamedConversation(current: ChatState, workspaceId: string, session: SessionRef, input: SessionActionInput) {
  if (input.action !== 'rename') return {};
  const view = conversationForSession(current, workspaceId, session);
  return view ? updateConversation(current, view, { title: input.title }) : {};
}
function newDefaults(current: ChatState) {
  return {
    agent: current.defaults.defaultAgent,
    modelOverrides: { ...EMPTY_MODEL_OVERRIDES },
    reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS },
    permission: undefined,
  };
}
export function lastWorkspaceId(): string | undefined {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function persistWorkspace(id?: string): void {
  try {
    if (id) localStorage.setItem(LAST_WORKSPACE_KEY, id);
    else localStorage.removeItem(LAST_WORKSPACE_KEY);
  } catch {
    /* 浏览器存储不可用时继续当前页面的内存选择。 */
  }
}

export const useChat = create<ChatState>()((set, get) => {
  const history = createChatHistory(get, set);
  return {
    followups: {},
    ...createAsyncQuestionActions(get, set, (message) => socket?.send(message) ?? false),
    ...createFollowupActions(get, set, (message) => socket?.send(message) ?? false),
    ...createAttachmentActions(get, set, () => socket?.identity?.()),
    nativeInteractions: [],
    respondInteraction(id, answer) {
      if (!InteractionAnswerSchema.safeParse(answer).success) return false;
      const state = get();
      const view = [state, ...Object.values(state.background)].find((view) =>
        view.items.some((item) => item.kind === 'interaction' && item.id === id && !item.resolved),
      );
      const items = view?.items ?? state.nativeInteractions;
      if (
        !items.some((item) => item.kind === 'interaction' && item.id === id && !item.resolved && !item.responding) ||
        !socket?.send({ type: 'interaction.respond', id, answer })
      )
        return false;
      const updated = items.map((item) =>
        item.kind === 'interaction' && item.id === id ? { ...item, responding: true } : item,
      );
      set(view ? updateConversation(state, view, { items: updated }) : { nativeInteractions: updated });
      return true;
    },
    dismissInteraction(id) {
      set((state) => ({ nativeInteractions: state.nativeInteractions.filter((item) => item.id !== id) }));
    },
    loadOlderHistory: history.loadOlder,
    cancelHistoryRead: () => {
      history.changeSelection();
    },
    connection: 'connecting',
    conversationId: crypto.randomUUID(),
    background: {},
    tabIds: [],
    ...createConversationTabs(get, set, history.changeSelection),
    conversationVisible: true,
    conversationVersion: 0,
    agent: 'claude',
    modelOverrides: { ...EMPTY_MODEL_OVERRIDES },
    defaults: { defaultAgent: 'claude' },
    permissionDefaults: emptyPermissionDefaults,
    readPermissionDefaults: () => readPermissionDefaults(get, set),
    initialDefaultsEligible: true,
    reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS },
    sessionOperations: {},
    sessionModels: {},
    inspectorRequest: 0,
    ...emptyConversation,
    setDraft: (draft) =>
      set((state) => ({
        draft,
        initialDefaultsEligible: false,
        tabIds: draft ? openedTab(state.tabIds, state.conversationId) : state.tabIds,
      })),
    setView: (view) => set({ view }),
    inspectItem(id) {
      if (id && !get().items.some((item) => item.id === id)) return;
      set((state) => ({ inspectedItemId: id, inspectorRequest: state.inspectorRequest + 1 }));
    },
    selectWorkspace(id, options) {
      if (get().workspaceId === id) return;
      const saved = Object.values(get().background).findLast((view) => view.workspaceId === id);
      if (saved && options?.restore !== false) return get().openConversation(saved.conversationId);
      const conversationVersion = history.changeSelection();
      persistWorkspace(id);
      set({
        workspaceId: id,
        ...emptyConversation,
        ...newDefaults(get()),
        conversationVersion,
        conversationId: crypto.randomUUID(),
        background: retainConversation(get()),
      });
    },
    openConversation(id) {
      const current = get();
      const saved = conversationById(current, id);
      if (!saved) return;
      if (!current.tabIds.includes(id)) set({ tabIds: openedTab(current.tabIds, id) });
      if (id !== current.conversationId) {
        history.changeSelection();
        const background = { ...retainConversation(current) };
        delete background[id];
        persistWorkspace(saved.workspaceId);
        set({ ...saved, background, unread: false, initialDefaultsEligible: false });
      }
      // 离开时取消了历史请求；回来后重读，不能永远停在加载状态。
      if ((saved.loadingHistory || saved.historyReloadNeeded) && saved.sessionId)
        void get().openSession({ agent: saved.agent, sessionId: saved.sessionId }, { preserveDraft: true });
    },
    removeWorkspace(id, nextId) {
      const prefix = JSON.stringify([id]).slice(0, -1) + ',';
      const sessionOperations = Object.fromEntries(
        Object.entries(get().sessionOperations).filter(([key]) => !key.startsWith(prefix)),
      );
      if (lastWorkspaceId() === id) persistWorkspace();
      // 迟到的删除结果只清理所属状态，不能切走用户已经选择的其他工作区。
      if (get().workspaceId === id) get().selectWorkspace(nextId);
      set({
        background: Object.fromEntries(Object.entries(get().background).filter(([, view]) => view.workspaceId !== id)),
        sessionOperations,
        sessionModels: Object.fromEntries(
          Object.entries(get().sessionModels).filter(([key]) => !key.startsWith(prefix)),
        ),
      });
      set({ tabIds: existingTabs(get()) });
    },
    newSession(agent = get().defaults.defaultAgent) {
      const conversationVersion = history.changeSelection();
      const conversationId = crypto.randomUUID();
      set({
        ...emptyConversation,
        ...newDefaults(get()),
        agent,
        initialDefaultsEligible: false,
        conversationVersion,
        conversationId,
        tabIds: openedTab(get().tabIds, conversationId),
        background: retainConversation(get()),
      });
    },
    resetWorkspaceConversation(id, expectedVersion) {
      const prefix = JSON.stringify([id]).slice(0, -1) + ',';
      // 迟到的改目录结果只清理来源项目，不能抢走用户的新选择。
      if (get().workspaceId === id && get().conversationVersion === expectedVersion) get().newSession(get().agent);
      set({
        sessionModels: Object.fromEntries(
          Object.entries(get().sessionModels).filter(([key]) => !key.startsWith(prefix)),
        ),
        background: Object.fromEntries(Object.entries(get().background).filter(([, view]) => view.workspaceId !== id)),
      });
      set({ tabIds: existingTabs(get()) });
    },
    setAgent(agent) {
      const current = get();
      if (current.draftAttachments.length || current.attachmentsBusy) {
        set({ banner: '请先移除当前附件，再切换 CLI。' });
        return;
      }
      if (current.sessionId || current.running || current.loadingHistory || current.pendingClientTurnId) return;
      set({ initialDefaultsEligible: false });
      if (current.agent !== agent) {
        const conversationVersion = history.changeSelection();
        set({ ...emptyConversation, draft: current.draft, agent, permission: undefined, conversationVersion });
      }
    },
    async openSession(session, options) {
      const { workspaceId } = get();
      if (!workspaceId) return;
      const saved = conversationForSession(get(), workspaceId, session);
      if (saved && saved.conversationId !== get().conversationId) {
        // 恢复内存内容而不是重新读取覆盖仍在更新的轮次。
        const background = { ...retainConversation(get()) };
        delete background[saved.conversationId];
        history.changeSelection();
        set({
          ...saved,
          background,
          tabIds: openedTab(get().tabIds, saved.conversationId),
          unread: false,
          initialDefaultsEligible: false,
        });
      }
      if (saved) {
        set({ tabIds: openedTab(get().tabIds, saved.conversationId) });
        if (session.title) set({ title: session.title });
        if (conversationBusy(saved) || saved.permissionSaving) return;
        if (!needsHistory(saved) && !options) return;
        options = { preserveDraft: true };
      }
      await history.read(workspaceId, session, options);
    },
    setDefaults(settings) {
      const current = get();
      const defaults = { defaultAgent: settings.defaultAgent, modelVisibility: settings.modelVisibility };
      set({ defaults });
      if (
        current.initialDefaultsEligible &&
        !current.sessionId &&
        !current.running &&
        !current.loadingHistory &&
        !current.pendingClientTurnId &&
        !current.items.length
      ) {
        set({ agent: defaults.defaultAgent, initialDefaultsEligible: false });
      }
    },
    touchDraft: () => set({ initialDefaultsEligible: false }),
    setModel: (model) =>
      set((current) => ({
        modelOverrides: { ...current.modelOverrides, [current.agent]: model },
        reasoningEfforts:
          model.trim() === current.modelOverrides[current.agent].trim()
            ? current.reasoningEfforts
            : { ...current.reasoningEfforts, [current.agent]: '' },
        initialDefaultsEligible: false,
      })),
    setPermission(permission) {
      const current = get();
      if (
        current.running ||
        current.pendingClientTurnId ||
        current.loadingHistory ||
        permissionEditorPending(current) ||
        managementPending(current)
      )
        return;
      if (permission && permission.agent !== current.agent) return;
      saveConversationPermission(get, set, current, permission);
    },
    setReasoningEffort: (reasoningEffort) =>
      set((current) => ({
        reasoningEfforts: { ...current.reasoningEfforts, [current.agent]: reasoningEffort },
        initialDefaultsEligible: false,
      })),
    setCollaborationMode: (collaborationMode) => set({ collaborationMode, initialDefaultsEligible: false }),
    selectCapability(capability) {
      const current = get();
      if (current.loadingHistory || managementPending(current)) return;
      if (capability && capabilityRestriction(capability, current.sessionId)) return;
      set({ selectedCapability: capability, initialDefaultsEligible: false });
    },
    async manageSession(workspaceId, session, input) {
      const key = sessionActionKey(workspaceId, session);
      const current = get();
      if (current.sessionOperations[key]?.pending) return false;
      if (sessionIsRunning(current, workspaceId, session)) {
        set({
          sessionOperations: {
            ...current.sessionOperations,
            [key]: { action: input.action, pending: false, error: '会话正在运行，请结束后再管理' },
          },
        });
        return false;
      }
      set({ sessionOperations: { ...current.sessionOperations, [key]: { action: input.action, pending: true } } });
      try {
        await sessionsApi.sessionAction(workspaceId, session.sessionId, session.agent, input);
        set(renamedConversation(get(), workspaceId, session, input));
        if (input.action === 'delete' || input.action === 'archive') {
          const view = conversationForSession(get(), workspaceId, session);
          if (view) get().closeConversationTab(view.conversationId);
          if (sameSession(get(), workspaceId, session)) {
            const conversationVersion = history.changeSelection();
            set({
              ...emptyConversation,
              ...newDefaults(get()),
              agent: session.agent,
              conversationVersion,
              conversationId: crypto.randomUUID(),
            });
          }
          set({
            background: Object.fromEntries(
              Object.entries(get().background).filter(([, view]) => !sameSession(view, workspaceId, session)),
            ),
          });
        }
        const operations = { ...get().sessionOperations };
        delete operations[key];
        if (input.action === 'delete') {
          const sessionModels = { ...get().sessionModels };
          delete sessionModels[key];
          set({ sessionModels });
        }
        set({ sessionOperations: operations });
        set({ tabIds: existingTabs(get()) });
        await refreshSessionLists(session.agent);
        return true;
      } catch (error) {
        set((latest) => ({
          sessionOperations: {
            ...latest.sessionOperations,
            [key]: {
              action: input.action,
              pending: false,
              error: error instanceof Error ? error.message : '会话操作未确认，请重新读取列表核对',
            },
          },
        }));
        return false;
      }
    },
    send(text) {
      get().syncAttachmentIdentity();
      const current = get();
      if (shouldQueue(current)) return current.sendFollowup(text, 'queue');
      if (!socket || !canStart(current, text)) return false;
      const restriction = sendRestriction(current, text);
      if (restriction) {
        set({ banner: restriction });
        return false;
      }
      const clientTurnId = crypto.randomUUID();
      const message = text;
      const submitted = { ...current, permission: conversationPermission(current) };
      const sent = socket.send(sendMessagePayload(submitted, message, clientTurnId));
      if (!sent) {
        set({ banner: '连接已断开，消息未发送。请等待重新连接后再试。' });
        return false;
      }
      set((state) => ({
        tabIds: openedTab(state.tabIds, state.conversationId),
        items: reduceChat(state.items, {
          type: 'user_message',
          text: current.selectedCapability ? `/${current.selectedCapability.name}${text ? ` ${text}` : ''}` : message,
          ...attachmentDisplay(current),
        }),
        selectedCapability: undefined,
        draft: '',
        draftAttachments: [],
        pendingAttachmentInput: sentAttachmentInput(current, message),
        // 旧轮次未确认的压缩留在历史中，新轮次不能把它重新显示为进行中。
        compaction: state.compaction?.status === 'running' ? undefined : state.compaction,
        contextWindow: undefined,
        running: true,
        lastSentAt: Date.now(),
        pendingClientTurnId: clientTurnId,
        permission: submitted.permission,
        runningInput: draftContent(submitted, message),
        interruptRequested: false,
        banner: undefined,
      }));
      return true;
    },
    interrupt() {
      get().interruptConversation(get().conversationId);
    },
    interruptConversation(id) {
      const state = get();
      const view = conversationById(state, id);
      if (!view || !conversationBusy(view) || view.interruptRequested) return;
      if (view.turnId) {
        if (!socket?.send({ type: 'chat.interrupt', turnId: view.turnId })) return;
      } else if (view.pendingClientTurnId) pendingInterrupts.add(view.pendingClientTurnId);
      set(updateConversation(state, view, { interruptRequested: true }));
    },
    respondPermission(requestId, allow) {
      const current = get();
      if (!canRespond(current, requestId)) return;
      if (!socket?.send({ type: 'permission.respond', turnId: current.turnId!, requestId, allow })) {
        set({ banner: '连接已断开，答复未发送。' });
        return;
      }
      set((state) => ({ items: markPermissionPending(state.items, requestId) }));
    },
    dismissBanner: () => set({ banner: undefined }),
    dismissNotice(id, conversationId) {
      const state = get();
      const view = conversationById(state, conversationId);
      if (!view?.items.some((item) => item.kind === 'error' && item.id === id)) return;
      const items = view.items.filter((item) => !(item.kind === 'error' && item.id === id));
      set(updateConversation(state, view, { items }));
    },
  };
});

function canRespond(current: ChatState, requestId: string): boolean {
  if (!current.running || !current.turnId || current.interruptRequested || current.connection !== 'open') return false;
  return current.items.some(
    (item) => item.kind === 'permission' && item.id === requestId && !item.resolved && !item.responding,
  );
}
type Connect = typeof connectChat;
export function startChatConnection(connect: Connect = connectChat): void {
  socket ??= connect(
    createChatEvents(
      useChat.getState,
      useChat.setState,
      (message) => socket?.send(message) ?? false,
      pendingInterrupts,
    ),
  );
}
export const reconnectChat = () => socket?.reconnect();

/** 插件续接指定的已打开会话；不切换页面，不覆盖草稿，也不把消息排入别的会话。 */
export function resumePluginConversation(input: { conversationId: string; requestId: string; text: string }): boolean {
  const previous = previousPluginInput(input.requestId);
  if (previous !== undefined) return previous;
  const state = useChat.getState();
  const view = conversationById(state, input.conversationId);
  if (!view || !view.sessionId || !state.tabIds.includes(view.conversationId)) return false;
  if (view.pendingClientTurnId === input.requestId) return true;
  const current = {
    ...state,
    ...view,
    selectedCapability: undefined,
    draftAttachments: [],
    attachmentsBusy: false,
    pendingAttachmentInput: undefined,
  };
  if (!socket || !canStart(current, input.text) || shouldQueue(current)) return false;
  const submitted = { ...current, permission: conversationPermission(current) };
  if (!socket.send(sendMessagePayload(submitted, input.text, input.requestId))) return false;
  markPluginInputSent(input.requestId);
  useChat.setState(
    updateConversation(state, view, {
      items: reduceChat(view.items, { type: 'user_message', text: input.text }),
      running: true,
      lastSentAt: Date.now(),
      pendingClientTurnId: input.requestId,
      permission: submitted.permission,
      runningInput: draftContent(submitted, input.text),
      interruptRequested: false,
      banner: undefined,
    }),
  );
  return false;
}

function attachmentRefs(state: ChatState) {
  return state.draftAttachments.length
    ? { attachments: state.draftAttachments.map((item) => ({ id: item.asset!.id, revision: item.asset!.revision })) }
    : {};
}
function attachmentDisplay(state: ChatState) {
  return state.draftAttachments.length ? { attachments: state.draftAttachments.map((item) => item.asset!) } : {};
}
