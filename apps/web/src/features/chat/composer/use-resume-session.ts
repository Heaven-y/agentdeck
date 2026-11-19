import { useState } from 'react';
import { NativeSessionIdSchema, type AgentKind, type SessionSummary } from '@agentdeck/shared/conversation';
import { sessionActionKey, useChat } from '../state/chat-store';
import { RESUME_SEARCH_LIMIT } from './resume-command';

export type ResumeScope = {
  workspaceId: string;
  agent: AgentKind;
  conversationId: string;
  conversationVersion: number;
};
export type ResumeRequest = ResumeScope & { search: string; draft: string };

function matchesOrigin(request: ResumeScope, current: ReturnType<typeof useChat.getState>) {
  return (
    request.workspaceId === current.workspaceId &&
    request.agent === current.agent &&
    request.conversationId === current.conversationId &&
    request.conversationVersion === current.conversationVersion
  );
}
export function matchesResumeTarget(scope: ResumeScope, session: SessionSummary) {
  return (
    session.projectId === scope.workspaceId &&
    session.agent === scope.agent &&
    NativeSessionIdSchema.safeParse(session.sessionId).success
  );
}

export function useResumeSession() {
  const [request, setRequest] = useState<ResumeRequest>();
  const current = useChat((state) => !request || matchesOrigin(request, state));
  if (!current) setRequest(undefined);
  function open(argument: string) {
    const { workspaceId, agent, conversationId, conversationVersion, draft } = useChat.getState();
    if (!workspaceId) return useChat.setState({ banner: '请先选择项目，再继续会话。' });
    const search = argument.trim();
    if (/[\r\n]/u.test(argument) || search.length > RESUME_SEARCH_LIMIT)
      return useChat.setState({ banner: '请输入单行 /resume [会话标题或 ID]，搜索内容最多 200 字符。' });
    setRequest({ workspaceId, agent, conversationId, conversationVersion, draft, search });
  }
  function close() {
    setRequest(undefined);
  }
  function choose(session: SessionSummary) {
    const state = useChat.getState();
    if (!request || !matchesOrigin(request, state) || !matchesResumeTarget(request, session)) return;
    if (state.sessionOperations[sessionActionKey(request.workspaceId, session)]?.pending) return;
    // 仅消费触发选择器的命令，不转移附件或覆盖其他会话草稿，也不打断已在运行的轮次。
    if (state.draft === request.draft && !state.selectedCapability) state.setDraft('');
    close();
    void state.openSession(session);
  }
  return { request: current ? request : undefined, open, close, choose };
}
