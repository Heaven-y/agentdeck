import { useSessionPages } from '../../features/sessions/queries/use-session-pages';
import { LoadMoreSessions } from '../../features/sessions/list/LoadMoreSessions';
import { Command } from 'cmdk';
import { useState } from 'react';
import { AGENT_KINDS, type AgentKind, type SessionSummary } from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import { DetailDialog } from '../../ui/DetailDialog';
import { AgentIcon } from '../../ui/BrandIcons';
import { inputClass } from '../../ui/styles';

import { sessionActionKey, useChat } from '../../features/chat/state/chat-store';
import { useUiPreferences } from '../../ui/appearance/ui-preferences';

export type PaletteActions = {
  conversation?(): boolean;
  newSession?(): boolean;
  openSession?(session: SessionSummary): boolean;
  selectWorkspace?(id: string): boolean;
  plugins?: Array<{ id: string; label: string; run(): boolean }>;
  settings(): boolean;
};
type Action = { id: string; label: string; workspace?: boolean; run(): boolean };
const itemClass =
  'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors data-[selected=true]:bg-control-hover data-[selected=true]:text-foreground data-[disabled=true]:opacity-45';
function commonActions(actions: PaletteActions): Action[] {
  return [
    ...(actions.plugins ?? []),
    {
      id: 'new',
      label: '新会话',
      workspace: true,
      run: () => {
        if (actions.newSession) return actions.newSession();
        if (actions.conversation?.() === false) return false;
        useChat.getState().newSession();
        return true;
      },
    },
    { id: 'settings', label: '打开设置', run: actions.settings },
    {
      id: 'sidebar',
      label: '折叠 / 展开侧栏',
      run: () => {
        const state = useUiPreferences.getState();
        state.setSidebarCollapsed(!state.sidebarCollapsed);
        return true;
      },
    },
  ];
}
function SessionSource({
  agent,
  workspaceId,
  sessions,
  choose,
}: {
  agent: AgentKind;
  workspaceId: string;
  sessions: SessionSummary[];
  choose(session: SessionSummary): void;
}) {
  const operations = useChat((state) => state.sessionOperations);
  if (!sessions.length) return null;
  return (
    <Command.Group
      heading={
        <span className="flex items-center gap-1.5">
          <AgentIcon agent={agent} className="size-3.5" />
          {{ claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }[agent]} 会话
        </span>
      }
    >
      {sessions.map((session) => (
        <Command.Item
          key={session.sessionId}
          value={`session:${agent}:${session.sessionId}`}
          keywords={[session.title, agent, session.sessionId]}
          className={itemClass}
          disabled={operations[sessionActionKey(workspaceId, session)]?.pending === true}
          onSelect={() => choose(session)}
        >
          <span className="truncate">{session.title || '无标题会话'}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{agent}</span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}
function PaletteSessions({
  workspace,
  search,
  choose,
}: {
  workspace?: Workspace;
  search: string;
  choose(session: SessionSummary): void;
}) {
  const page = useSessionPages({ projectId: workspace?.id, search, enabled: !!workspace });
  if (!workspace) return null;
  return (
    <>
      {page.loading && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          正在读取会话…
        </p>
      )}
      {page.errors.map((error) => (
        <p key={error.agent} role="alert" className="px-3 py-2 text-xs text-destructive-foreground">
          {error.agent} 会话：{error.message}
        </p>
      ))}
      {page.errors.length > 0 && (
        <button type="button" onClick={page.retry}>
          重新读取
        </button>
      )}
      {AGENT_KINDS.map((agent) => (
        <SessionSource
          key={agent}
          agent={agent}
          workspaceId={workspace.id}
          sessions={page.sessions.filter((row) => row.agent === agent)}
          choose={choose}
        />
      ))}
      <LoadMoreSessions hasMore={page.hasMore} loading={page.loadingMore} more={page.more} />
    </>
  );
}
export default function CommandPalette({
  workspaces,
  workspace,
  actions,
  close,
}: {
  workspaces: Workspace[];
  workspace?: Workspace;
  actions: PaletteActions;
  close(): void;
}) {
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string>();
  const run = (action: Action) => {
    if (action.workspace && (!workspace || useChat.getState().workspaceId !== workspace.id)) {
      setError('项目已改变，请重新打开搜索与操作。');
      return;
    }
    if (!action.run()) {
      setError('当前操作暂不可用，请重新打开对应面板。');
      return;
    }
    close();
  };
  const choose = (session: SessionSummary) =>
    run({
      id: session.sessionId,
      label: session.title,
      workspace: true,
      run: () => {
        if (actions.openSession) return actions.openSession(session);
        if (actions.conversation?.() === false) return false;
        void useChat.getState().openSession(session);
        return true;
      },
    });
  return (
    <DetailDialog title="搜索与操作" onClose={close}>
      <Command
        label="项目、会话和常用操作"
        loop
        filter={(value, search, keywords = []) =>
          value.startsWith('session:')
            ? 1
            : `${value} ${keywords.join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
              ? 1
              : 0
        }
      >
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder="搜索项目、会话或操作…"
          aria-label="搜索命令"
          className={inputClass}
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive-foreground">
            {error}
          </p>
        )}
        <Command.List className="mt-3 max-h-[50vh] overflow-y-auto">
          <Command.Empty className="px-3 py-6 text-sm text-muted-foreground">没有匹配结果。</Command.Empty>
          <Command.Group heading="项目">
            {workspaces.map((target) => (
              <Command.Item
                key={target.id}
                value={`workspace:${target.id}`}
                keywords={[target.name]}
                className={itemClass}
                onSelect={() => {
                  if (!workspaces.some((item) => item.id === target.id)) {
                    setError('项目已移除。');
                    return;
                  }
                  if (actions.selectWorkspace) {
                    if (!actions.selectWorkspace(target.id)) return;
                  } else {
                    if (actions.conversation?.() === false) return;
                    useChat.getState().selectWorkspace(target.id, { restore: false });
                  }
                  close();
                }}
              >
                {target.name}
                <span className="text-xs text-muted-foreground">切换项目</span>
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="常用操作">
            {commonActions(actions).map((action) => (
              <Command.Item
                key={action.id}
                value={`action:${action.id}`}
                keywords={[action.label]}
                className={itemClass}
                disabled={action.workspace && !workspace}
                onSelect={() => run(action)}
              >
                {action.label}
              </Command.Item>
            ))}
          </Command.Group>
          <PaletteSessions workspace={workspace} search={search} choose={choose} />
        </Command.List>
      </Command>
    </DetailDialog>
  );
}
