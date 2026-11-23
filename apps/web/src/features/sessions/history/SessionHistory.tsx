import { MessagesSquare } from 'lucide-react';
import type { AgentKind } from '@agentdeck/shared/conversation';

import { useChat } from '../../chat/state/chat-store';
import { agentVersion, useEnvironment } from '../../settings/environment/use-environment';
import { SessionHeader } from './SessionHeader';
import { SessionTimeline } from './SessionTimeline';
import { useSessionHistory } from '../queries/use-sessions';

function SelectSession() {
  return (
    <div className="m-auto max-w-md px-6 py-12 text-center">
      <MessagesSquare aria-hidden className="mx-auto size-8 text-muted-foreground" />
      <h2 className="mt-3 text-base font-medium">选择一条会话查看历史</h2>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">从左侧项目中选择会话。</p>
    </div>
  );
}

/**
 * 只读会话视图：会话头 + 原生历史时间线。
 * 会话身份（CLI + 原生 id）来自 chat store 的选择，正文由 react-query 单独读取，
 * 这样不可回放的错误码不会被实时对话的通用错误横幅吞掉。
 */
export function SessionHistory({ projectId, projectDir }: { projectId: string; projectDir: string }) {
  const agent = useChat((state) => state.agent);
  const sessionId = useChat((state) => state.sessionId);
  if (!sessionId) return <SelectSession />;
  return (
    <SelectedSession
      key={JSON.stringify([projectId, agent, sessionId])}
      projectId={projectId}
      projectDir={projectDir}
      agent={agent}
      sessionId={sessionId}
    />
  );
}

function SelectedSession({
  projectId,
  projectDir,
  agent,
  sessionId,
}: {
  projectId: string;
  projectDir: string;
  agent: AgentKind;
  sessionId: string;
}) {
  const environment = useEnvironment();
  const { history, failure, notReplayable, loading, retry } = useSessionHistory(projectId, { agent, sessionId });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionHeader
        agent={agent}
        title={history?.session.summary ?? ''}
        version={agentVersion(environment.data, agent)}
        projectDir={projectDir}
      />
      <SessionTimeline
        events={history?.events ?? []}
        source={{ workspaceId: projectId, agent, sessionId }}
        notReplayable={notReplayable}
        error={failure}
        loading={loading}
        onRetry={retry}
      />
    </div>
  );
}
