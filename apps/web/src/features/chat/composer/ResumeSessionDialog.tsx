import { useLayoutEffect, useRef, useState } from 'react';
import { Command } from 'cmdk';
import type { SessionSummary } from '@agentdeck/shared/conversation';
import { AGENT_FULL_NAMES } from '../../../cli/shared/labels';
import { DetailDialog } from '../../../ui/DetailDialog';
import { buttonClass } from '../../../ui/styles';
import { LoadMoreSessions } from '../../sessions/list/LoadMoreSessions';
import { useAgentSessionPages } from '../../sessions/queries/use-session-pages';
import { sessionActionKey, useChat } from '../state/chat-store';
import { RESUME_SEARCH_LIMIT } from './resume-command';
import { matchesResumeTarget, type ResumeRequest, type ResumeScope } from './use-resume-session';

function ResumeOption({ request, session, choose }: { request: ResumeScope; session: SessionSummary; choose(): void }) {
  const pending = useChat((state) => state.sessionOperations[sessionActionKey(request.workspaceId, session)]?.pending);
  const current = useChat((state) => state.sessionId === session.sessionId);
  return (
    <Command.Item
      value={session.sessionId}
      disabled={pending}
      onSelect={choose}
      className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 outline-none data-[selected=true]:bg-muted data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-45"
    >
      <div className="min-w-0">
        <div className="truncate text-sm">{session.title || '无标题会话'}</div>
        <div className="truncate font-mono text-xs text-muted-foreground" title={session.sessionId}>
          {session.sessionId}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {pending ? '操作处理中' : current ? '当前会话' : session.running ? '运行中' : ''}
      </span>
    </Command.Item>
  );
}

export default function ResumeSessionDialog({
  request,
  choose,
  close,
}: {
  request: ResumeRequest;
  choose(session: SessionSummary): void;
  close(): void;
}) {
  const [search, setSearch] = useState(request.search);
  const input = useRef<HTMLInputElement>(null);
  // 等原生 dialog 打开并取得焦点后，再将焦点放到可立即输入和选择的搜索框。
  useLayoutEffect(() => input.current?.focus(), []);
  const page = useAgentSessionPages(request.agent, request.workspaceId, search);
  const targets = page.sessions.filter((session) => matchesResumeTarget(request, session));
  return (
    <DetailDialog title="继续会话" onClose={close}>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        当前项目的 {AGENT_FULL_NAMES[request.agent]} 会话。打开后自行发送下一条消息；已归档会话需先恢复。
      </p>
      <Command label="搜索会话标题或 ID" shouldFilter={false} loop>
        <Command.Input
          ref={input}
          value={search}
          onValueChange={setSearch}
          maxLength={RESUME_SEARCH_LIMIT}
          placeholder="搜索会话标题或 ID…"
          className="w-full rounded-md border border-border-strong bg-background px-3 py-2 text-sm"
        />
        <Command.List className="mt-2 max-h-[42vh] overflow-y-auto">
          {targets.map((session) => (
            <ResumeOption key={session.sessionId} request={request} session={session} choose={() => choose(session)} />
          ))}
        </Command.List>
      </Command>
      {page.loading && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          正在读取会话…
        </p>
      )}
      {page.error && (
        <div className="space-y-2 px-3 py-2">
          <p role="alert" className="text-xs text-warning">
            {page.error}
          </p>
          <button type="button" className={buttonClass('outline')} onClick={page.retry}>
            重试读取会话
          </button>
        </div>
      )}
      {!page.loading && !page.error && !targets.length && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {page.hasMore ? '本页没有匹配会话，可继续加载。' : '没有匹配的会话。'}
        </p>
      )}
      <LoadMoreSessions hasMore={page.hasMore} loading={page.loadingMore} more={page.more} />
    </DetailDialog>
  );
}
