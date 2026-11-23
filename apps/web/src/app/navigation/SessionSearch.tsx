import { Command } from 'cmdk';
import { useState } from 'react';
import type { Workspace } from '@agentdeck/shared/projects';
import { useProjectSessions } from '../../features/projects/use-project-sessions';
import { useWorkspaceSessions, type WorkspaceSession } from '../../features/sessions/list/workspace-sessions';
import { matchesSessionSearch } from '../../features/sessions/list/session-search';
import { recentSessionsFirst } from '../../features/sessions/list/session-order';
import { LoadMoreSessions } from '../../features/sessions/list/LoadMoreSessions';
import { useChat, sessionActionKey } from '../../features/chat/state/chat-store';
import { AGENT_LABELS } from '../../cli/shared/labels';
import { AgentIcon } from '../../ui/BrandIcons';
import { DetailDialog } from '../../ui/DetailDialog';
import { buttonClass, inputClass } from '../../ui/styles';

export default function SessionSearch({
  projects,
  open,
  close,
}: {
  projects: Workspace[];
  open(projectId: string, session: WorkspaceSession): boolean;
  close(): void;
}) {
  const [search, setSearch] = useState('');
  const page = useProjectSessions(projects, search);
  const sessions = useWorkspaceSessions(page.sessionsByProject);
  const operations = useChat((state) => state.sessionOperations);
  return (
    <DetailDialog title="搜索会话" onClose={close}>
      <Command label="搜索会话" shouldFilter={false} loop>
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          aria-label="搜索会话"
          placeholder="输入标题、会话 ID、CLI 或项目名称…"
          className={inputClass}
        />
        <Command.List className="mt-3 max-h-[55vh] overflow-y-auto">
          {projects.map((project) => {
            const rows = (sessions[project.id] ?? [])
              .filter((row) => matchesSessionSearch(row, search, project.name))
              .toSorted(recentSessionsFirst);
            return (
              rows.length > 0 && (
                <Command.Group key={project.id} heading={project.name}>
                  {rows.map((session) => (
                    <Command.Item
                      key={`${session.agent}:${session.sessionId}`}
                      value={`${project.id}:${session.agent}:${session.sessionId}`}
                      disabled={operations[sessionActionKey(project.id, session)]?.pending === true}
                      onSelect={() => {
                        if (open(project.id, session)) close();
                      }}
                      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] data-[selected=true]:bg-control-hover data-[disabled=true]:opacity-45"
                    >
                      <AgentIcon agent={session.agent} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{session.title || '未命名会话'}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{AGENT_LABELS[session.agent]}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )
            );
          })}
          {!page.loading && (
            <Command.Empty className="px-3 py-6 text-sm text-muted-foreground">没有匹配的会话。</Command.Empty>
          )}
        </Command.List>
        {page.loading && (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            正在读取会话…
          </p>
        )}
        {page.errors.map((error) => (
          <p role="alert" key={error.agent} className="mt-2 text-sm text-destructive-foreground">
            {AGENT_LABELS[error.agent]}：{error.message}
          </p>
        ))}
        {page.errors.length > 0 && (
          <button type="button" className={buttonClass('outline')} onClick={page.retry}>
            重试
          </button>
        )}
        <LoadMoreSessions hasMore={page.hasMore} loading={page.loadingMore} more={page.more} />
      </Command>
    </DetailDialog>
  );
}
