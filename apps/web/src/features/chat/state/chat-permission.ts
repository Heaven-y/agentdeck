import {
  permissionForNewSession,
  type AgentKind,
  type PermissionSelection,
  type SessionPermissionDefaults,
  type SessionPermissionDocument,
} from '@agentdeck/shared/conversation';
import { sessionsApi } from '../../sessions/api';
import type { ChatState, ConversationView } from './chat-state';
import { sameSession } from './chat-state-helpers';
import { conversationBusy, conversationById, updateConversation } from './conversations';

export type PermissionDefaultsState = {
  values: SessionPermissionDefaults;
  loading: boolean;
  readError?: string;
  saving: Partial<Record<AgentKind, true>>;
  saveErrors: Partial<Record<AgentKind, string>>;
};
export const emptyPermissionDefaults: PermissionDefaultsState = {
  values: {},
  loading: false,
  saving: {},
  saveErrors: {},
};

const followsPermissionDefault = (view: ConversationView) => !view.sessionId && !conversationBusy(view);
const defaultsPending = (state: ChatState, agent = state.agent) =>
  state.permissionDefaults.loading || !!state.permissionDefaults.saving[agent];

/** 仅未建立原生会话、也未提交首轮的草稿读取默认值；发出后锁定本轮快照。 */
export const conversationPermission = (state: ChatState, view: ConversationView = state) =>
  followsPermissionDefault(view) ? state.permissionDefaults.values[view.agent] : view.permission;
export const permissionPending = (state: ChatState, view: ConversationView = state) =>
  view.permissionLoading ||
  view.permissionSaving ||
  (followsPermissionDefault(view) && defaultsPending(state, view.agent));
export const permissionEditorPending = (state: ChatState) =>
  state.permissionLoading || state.permissionSaving || defaultsPending(state);
export const conversationPermissionError = (state: ChatState, view: ConversationView = state) =>
  view.permissionError ??
  (followsPermissionDefault(view)
    ? (state.permissionDefaults.readError ?? state.permissionDefaults.saveErrors[view.agent])
    : undefined);

export async function readPermissionDefaults(get: () => ChatState, set: (patch: Partial<ChatState>) => void) {
  const defaults = get().permissionDefaults;
  if (defaults.loading || Object.values(defaults.saving).some(Boolean)) return;
  set({ permissionDefaults: { ...defaults, loading: true, readError: undefined } });
  try {
    const values = await sessionsApi.permissionDefaults(AbortSignal.timeout(10_000));
    set({ permissionDefaults: { ...emptyPermissionDefaults, values } });
  } catch {
    set({ permissionDefaults: { ...defaults, readError: '新会话权限读取失败，请重新读取。' } });
  }
}

export function permissionReadState(result: PromiseSettledResult<SessionPermissionDocument>) {
  return {
    permissionLoading: false,
    permission: result.status === 'fulfilled' ? (result.value.permission ?? undefined) : undefined,
    permissionError: result.status === 'rejected' ? '会话权限读取失败，请重新读取后再发送。' : undefined,
  };
}

/** 同一 CLI 的修改串行。只更新该 CLI 默认和发起修改的会话，不改写其他原生会话。 */
export function saveConversationPermission(
  get: () => ChatState,
  set: (patch: Partial<ChatState>) => void,
  current: ChatState,
  permission?: PermissionSelection,
) {
  const { workspaceId, sessionId, agent, conversationId, permissionDefaults } = current;
  if (sessionId && !workspaceId) return;
  const session = sessionId && workspaceId ? { workspaceId, ref: { agent, sessionId } } : undefined;
  set({
    ...(session ? { permission, permissionSaving: true, permissionError: undefined } : {}),
    initialDefaultsEligible: false,
    permissionDefaults: { ...permissionDefaults, saving: { ...permissionDefaults.saving, [agent]: true } },
  });
  function complete(confirmed: boolean) {
    const state = get();
    const next = completedDefault(state.permissionDefaults, agent, permission, confirmed);
    const view = session && conversationById(state, conversationId);
    const patch: Partial<ConversationView> = confirmed
      ? { permissionSaving: false, permissionError: undefined }
      : {
          permissionSaving: false,
          permission: current.permission,
          permissionError: '会话权限保存失败，请重新选择或重新读取权限。',
        };
    set({
      ...(session && view && sameSession(view, session.workspaceId, session.ref)
        ? updateConversation(state, view, patch)
        : {}),
      permissionDefaults: next,
    });
  }
  const saving = session
    ? sessionsApi.saveSessionPermission(session.workspaceId, session.ref.sessionId, agent, permission ?? null)
    : sessionsApi.savePermissionDefault(agent, permissionForNewSession(permission) ?? null);
  void saving.then(
    () => complete(true),
    () => complete(false),
  );
}

function completedDefault(
  current: PermissionDefaultsState,
  agent: AgentKind,
  permission: PermissionSelection | undefined,
  confirmed: boolean,
): PermissionDefaultsState {
  const { saving, saveErrors, values } = current;
  const pending = { ...saving };
  delete pending[agent];
  // 断线时写入可能已落盘，重读后才能为该 CLI 的新会话使用缓存。
  if (!confirmed)
    return {
      ...current,
      saving: pending,
      saveErrors: { ...saveErrors, [agent]: '新会话权限保存未确认，请重新读取。' },
    };
  const next = { ...values };
  const errors = { ...saveErrors };
  delete errors[agent];
  const selected = permissionForNewSession(permission);
  if (selected) next[agent] = selected;
  else delete next[agent];
  return { ...current, saving: pending, values: next, saveErrors: errors };
}
