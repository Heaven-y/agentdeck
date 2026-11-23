import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { shallow } from 'zustand/shallow';
import type { SessionSummary } from '@agentdeck/shared/conversation';
import { useChat } from '../../chat/state/chat-store';
import {
  conversationBusy,
  conversationHasInput,
  conversationTitle,
  conversationViews,
  waitingPermission,
} from '../../chat/state/conversations';
import { queueHasPending } from '../../chat/followups/followup-state';
import type { ChatState, ConversationView } from '../../chat/state/chat-state';
import { sessionOrderKey } from './session-order';

export type SessionActivity = 'approval' | 'stopping' | 'queued' | 'unread' | 'draft';
export type WorkspaceSession = SessionSummary & {
  conversationId?: string;
  local?: boolean;
  activity?: SessionActivity;
};
export const localSessionId = (conversationId: string) => `local:${conversationId}`;

type NavigationEntry = Pick<WorkspaceSession, 'agent' | 'sessionId' | 'title' | 'running'> & {
  conversationId: string;
  workspaceId: string;
  lastSentAt?: number;
  activity?: SessionActivity;
};
function activity(view: ConversationView, queued: boolean): SessionActivity | undefined {
  if (waitingPermission(view)) return 'approval';
  if (view.interruptRequested) return 'stopping';
  if (queued) return 'queued';
  if (view.unread) return 'unread';
  if (conversationHasInput(view)) return 'draft';
  return undefined;
}
function navigationEntry(state: ChatState, view: ConversationView): NavigationEntry | undefined {
  if (!view.workspaceId) return;
  const running = conversationBusy(view);
  const queued = queueHasPending(state.followups, view);
  const closedDraft = !state.tabIds.includes(view.conversationId) && conversationHasInput(view);
  if (!view.sessionId && view.lastSentAt === undefined && !running && !queued && !closedDraft) return;
  return {
    conversationId: view.conversationId,
    workspaceId: view.workspaceId,
    agent: view.agent,
    sessionId: view.sessionId ?? localSessionId(view.conversationId),
    lastSentAt: view.lastSentAt,
    title: conversationTitle(view),
    running,
    activity: activity(view, queued),
  };
}
/** 后台正文增量不改变导航投影，避免每个 token 都重排整份摘要。 */
function navigationSelector() {
  let previous = new Map<string, NavigationEntry>();
  return (state: ChatState) => {
    const next = new Map<string, NavigationEntry>();
    for (const view of conversationViews(state)) {
      const entry = navigationEntry(state, view);
      if (!entry) continue;
      const cached = previous.get(view.conversationId);
      next.set(view.conversationId, cached && shallow(cached, entry) ? cached : entry);
    }
    previous = next;
    return [...next.values()];
  };
}

/** 原生标题可能还没落库（AGY 在进程退出后才写）；空标题不能顶掉本地推导的标题。 */
const preferredTitle = (native: string | undefined, local: string) => native || local;

function mergeSession(view: NavigationEntry, existing?: WorkspaceSession): WorkspaceSession {
  const updatedAt = Math.max(view.lastSentAt ?? 0, Date.parse(existing?.updatedAt ?? '') || 0);
  return {
    agent: view.agent,
    sessionId: view.sessionId,
    projectId: view.workspaceId,
    ...existing,
    title: preferredTitle(existing?.title, view.title),
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : '',
    running: view.running || existing?.running === true,
    conversationId: view.conversationId,
    local: !existing,
    activity: view.activity,
  };
}

/** 已读历史与本页任务共用工作区导航；是否发送过消息不决定标题和运行状态能否同步。 */
export function useWorkspaceSessions(native: Record<string, SessionSummary[]>) {
  const select = useMemo(() => navigationSelector(), []);
  const current = useChat(useShallow(select));
  return useMemo(() => {
    const result: Record<string, WorkspaceSession[]> = Object.fromEntries(
      Object.entries(native).map(([id, sessions]) => [id, [...sessions]]),
    );
    for (const view of current) {
      const sessions = (result[view.workspaceId] ??= []);
      const identity = { agent: view.agent, sessionId: view.sessionId };
      const index = sessions.findIndex((session) => sessionOrderKey(session) === sessionOrderKey(identity));
      const existing = sessions[index];
      const entry = mergeSession(view, existing);
      if (existing) sessions[index] = entry;
      else sessions.push(entry);
    }
    return result;
  }, [native, current]);
}
