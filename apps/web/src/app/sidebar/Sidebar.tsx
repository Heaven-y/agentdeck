import { ChevronDown, ChevronUp, Folder, FolderOpen, FolderPlus } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentKind, SessionSummary } from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import { AGENT_LABELS } from '../../cli/shared/labels';
import { sessionActionKey, useChat } from '../../features/chat/state/chat-store';
import { SortableSessionRow as SessionRow } from '../../features/sessions/list/SortableSessionRow';
import {
  recentSessionsFirst,
  sessionOrderKey,
  sortSessions,
  useSessionOrder,
} from '../../features/sessions/list/session-order';
import { ProjectSessionDialog, type ProjectSessionSelection } from '../../features/sessions/list/ProjectSessionDialog';
import type { SessionDialogAction } from '../../features/sessions/actions/SessionMenu';
import { buttonClass } from '../../ui/styles';
import { useUiPreferences } from '../../ui/appearance/ui-preferences';
import { ProjectMenu } from '../../features/projects/ProjectMenu';
import { NewSessionMenu, SidebarMore } from './SidebarActions';
import { SidebarBrand, SidebarFooter, SidebarWorkspaces } from './SidebarChrome';
import { SidebarOtherSessions } from './SidebarOtherSessions';
import type { ProjectDraft, ProjectManageAction } from '../../features/projects/project-management';
import type { SessionListFailure } from '../../features/projects/use-project-sessions';
import { LoadMoreSessions } from '../../features/sessions/list/LoadMoreSessions';
import { ProjectSessionRow } from '../../features/sessions/list/ProjectSessionRow';
import {
  localSessionId,
  useWorkspaceSessions,
  type WorkspaceSession,
} from '../../features/sessions/list/workspace-sessions';
import { useProductSettings } from '../../features/settings/general/use-product-settings';
import { matchesSessionSearch as matchesSession } from '../../features/sessions/list/session-search';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi, settingsKeys } from '../../features/settings/api';

export type SidebarProps = {
  pages?: ReactNode;
  search?: string;
  onSearch?(value: string): void;
  sessionPages?: { hasMore: boolean; loadingMore: boolean; more(): void };
  otherPages?: { hasMore: boolean; loadingMore: boolean; more(): void };
  projects: Workspace[];
  /** 按项目 id 归集的会话；未归属会话由侧栏去重后按需展示。 */
  sessionsByProject: Record<string, SessionSummary[]>;
  sessionErrorsByProject?: Record<string, SessionListFailure[]>;
  onRetrySessions?(projectId: string): void;
  otherSessions?: SessionSummary[];
  loadingOtherSessions?: boolean;
  otherSessionsError?: string;
  onShowOtherSessions?(show: boolean): void;
  onAddProject(initial?: ProjectDraft): void;
  onManageProject?(project: Workspace, action: ProjectManageAction): void;
  onNewSession?(projectId: string, agent: AgentKind): void;
  onSelectProject?(projectId: string): void;
  onSelectSession?(projectId: string, session: SessionSummary): void;
  /** 桌面壳提供打开路径能力时，项目菜单显示“在资源管理器中打开”。 */
  reveal?(project: Workspace): { label: string; open(): void } | undefined;
  onOpenSettings?(): void;
  onOpenSessionSearch?(): void;
  onOpenArchive?(): void;
  onOpenConversation?(id: string): void;
  /** 会话仍在读取时不要把加载中误报成空列表。 */
  loadingSessions?: boolean;
  currentProjectId?: string;
};

const EMPTY_SESSIONS: SessionSummary[] = [];
const EMPTY_FAILURES: SessionListFailure[] = [];
/** 产品设置未读到时的取值，与 DEFAULT_APPEARANCE.sessionLimit 一致。 */
const FALLBACK_SESSION_LIMIT = 5;

function unassignedSessions(sessions: Record<string, SessionSummary[]>, extra: SessionSummary[]) {
  const entries = new Map<string, SessionSummary>();
  for (const session of [...Object.values(sessions).flat(), ...extra]) {
    if (session.projectId === null) entries.set(`${session.agent}:${session.sessionId}`, session);
  }
  return [...entries.values()].toSorted(recentSessionsFirst);
}

function visibleProjects(projects: Workspace[], sessions: Record<string, WorkspaceSession[]>, query: string) {
  return projects.flatMap((project) => {
    const items = sessions[project.id] ?? EMPTY_SESSIONS;
    const matchesProject = `${project.name} ${project.dir}`.toLocaleLowerCase().includes(query);
    const visible = matchesProject ? items : items.filter((session) => matchesSession(session, query));
    return matchesProject || visible.length > 0 ? [{ project, sessions: visible }] : [];
  });
}

function displayedProjectSessions(sessions: WorkspaceSession[], activeKey: string, showAll: boolean, limit: number) {
  if (showAll || sessions.length <= limit) return sessions;
  const visible = sessions.slice(0, limit);
  const active = sessions.find((session) => sessionActionKey(session.projectId ?? '', session) === activeKey);
  if (active && !visible.some((session) => sessionActionKey(session.projectId ?? '', session) === activeKey)) {
    visible[visible.length - 1] = active;
    const positions = new Map(
      sessions.map((session, index) => [sessionActionKey(session.projectId ?? '', session), index]),
    );
    visible.sort(
      (left, right) =>
        (positions.get(sessionActionKey(left.projectId ?? '', left)) ?? 0) -
        (positions.get(sessionActionKey(right.projectId ?? '', right)) ?? 0),
    );
  }
  return visible;
}

/** 项目菜单的“在文件管理器中打开”只在桌面壳提供能力时出现。 */
function projectReveal(reveal: SidebarProps['reveal'], project: Workspace) {
  return reveal ? reveal(project) : undefined;
}

function ProjectItem({
  project,
  sessions,
  searching,
  expanded,
  current,
  loading,
  incomplete,
  failures,
  retry,
  running,
  activeKey,
  toggle,
  selectSession,
  newSession,
  manageSession,
  onManageProject,
  reveal,
}: {
  project: Workspace;
  sessions: WorkspaceSession[];
  searching: boolean;
  expanded: boolean;
  current: boolean;
  loading: boolean;
  incomplete: boolean;
  failures: SessionListFailure[];
  retry?: () => void;
  running: boolean;
  activeKey: string;
  toggle(): void;
  selectSession?: (session: WorkspaceSession) => void;
  newSession?: SidebarProps['onNewSession'];
  manageSession: (session: SessionSummary, action: SessionDialogAction, archived: boolean) => void;
  onManageProject?: SidebarProps['onManageProject'];
  reveal?: SidebarProps['reveal'];
}) {
  const FolderIcon = expanded ? FolderOpen : Folder;
  const sessionLimit = useProductSettings().data?.settings.appearance.sessionLimit ?? FALLBACK_SESSION_LIMIT;
  const sortableSessions = useMemo(() => sessions.filter((session) => !session.local), [sessions]);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const visibleSessions = useMemo(
    () => displayedProjectSessions(sessions, activeKey, searching || showAllSessions, sessionLimit),
    [sessions, activeKey, searching, showAllSessions, sessionLimit],
  );
  return (
    <li className="min-w-0">
      <div className="group flex min-w-0 items-center rounded-lg transition-colors hover:bg-control-hover/70">
        <button
          type="button"
          aria-expanded={expanded}
          aria-current={current ? 'true' : undefined}
          title={project.dir}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[13px] text-foreground focus-visible:outline-interactive"
          onClick={toggle}
        >
          <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
          <span
            title={
              searching ? `当前搜索结果：${sessions.length} 条会话` : `已加载会话及本页临时会话：${sessions.length} 条`
            }
            className="shrink-0 rounded-full bg-control-hover/90 px-1.5 py-0.5 text-[11px] leading-none tabular-nums text-muted-foreground"
          >
            {sessions.length}
          </span>
        </button>
        <ProjectMenu
          project={project}
          running={running}
          choose={onManageProject ? (action) => onManageProject(project, action) : undefined}
          reveal={projectReveal(reveal, project)}
        />
        <NewSessionMenu
          projects={[project]}
          collapsed={false}
          compact
          onNewSession={newSession}
          onAddProject={() => {}}
        />
      </div>
      {expanded && (
        <section
          aria-label={`${project.name}会话`}
          className="project-session-list mb-2 ml-4 border-l border-border/80 pl-2"
        >
          <ProjectSessionStatus
            loading={loading}
            incomplete={incomplete}
            empty={sessions.length === 0}
            failures={failures}
            retry={retry}
          />
          {sessions.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {visibleSessions.map((session) => {
                const Row = session.local ? ProjectSessionRow : SessionRow;
                return (
                  <Row
                    key={`${session.agent}:${session.sessionId}`}
                    session={session}
                    sessions={sortableSessions}
                    workspaceId={project.id}
                    active={activeKey === sessionActionKey(project.id, session)}
                    select={selectSession ? () => selectSession(session) : undefined}
                    manage={session.local ? undefined : (action) => manageSession(session, action, false)}
                  />
                );
              })}
            </ul>
          )}
          <ProjectSessionExpansionControl
            count={sessions.length}
            limit={sessionLimit}
            expanded={showAllSessions}
            searching={searching}
            toggle={() => setShowAllSessions((expanded) => !expanded)}
          />
        </section>
      )}
    </li>
  );
}

function ProjectSessionStatus({
  loading,
  incomplete,
  empty,
  failures,
  retry,
}: {
  loading: boolean;
  incomplete: boolean;
  empty: boolean;
  failures: SessionListFailure[];
  retry?: () => void;
}) {
  if (failures.length > 0)
    return (
      <div className="space-y-1 px-3 py-2 text-xs">
        {failures.map((failure) => (
          <p key={failure.agent} role="alert" className="break-words leading-5 text-destructive-foreground">
            {AGENT_LABELS[failure.agent]}：{failure.message}
          </p>
        ))}
        {retry && (
          <button type="button" className="min-h-8 rounded underline underline-offset-4" onClick={retry}>
            重新读取会话
          </button>
        )}
      </div>
    );
  if (!empty || incomplete) return null;
  return (
    <p role={loading ? 'status' : undefined} className="px-3 py-2 text-xs text-muted-foreground">
      {loading ? '正在读取会话…' : '暂无会话'}
    </p>
  );
}

function ProjectSessionExpansionControl({
  count,
  limit,
  expanded,
  searching,
  toggle,
}: {
  count: number;
  limit: number;
  expanded: boolean;
  searching: boolean;
  toggle(): void;
}) {
  if (searching || count <= limit) return null;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className="flex min-h-8 items-center gap-1 rounded px-3 text-xs text-muted-foreground hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
      onClick={toggle}
    >
      {expanded ? <ChevronUp aria-hidden className="size-3.5" /> : <ChevronDown aria-hidden className="size-3.5" />}
      {expanded ? '收起' : `展开其余 ${count - limit} 条`}
    </button>
  );
}

function EmptyProjects({ addProject }: { addProject(): void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-4 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-background/70 text-muted-foreground">
        <FolderPlus aria-hidden className="size-5" />
      </div>
      <p className="text-[13px] font-medium">还没有项目</p>
      <p className="text-xs leading-5 text-muted-foreground">添加本地目录后，这里会列出对应会话。</p>
      <button type="button" className={`${buttonClass('outline')} mt-0.5`} onClick={addProject}>
        添加项目目录
      </button>
    </div>
  );
}

function WorkspaceListNotice({
  projects,
  visibleCount,
  incomplete,
  addProject,
}: {
  projects: Workspace[];
  visibleCount: number;
  incomplete: boolean;
  addProject(): void;
}) {
  if (projects.length === 0) return <EmptyProjects addProject={addProject} />;
  if (visibleCount > 0 || incomplete) return null;
  return <p className="px-3 py-5 text-xs text-muted-foreground">没有匹配的工作区或会话</p>;
}

function useSidebarSelection(projects: Workspace[], currentProjectId?: string) {
  const settings = useProductSettings();
  const client = useQueryClient();
  const saveExpansion = useMutation({
    mutationFn: ({ id, expanded }: { id: string; expanded: boolean }) => settingsApi.setWorkspaceExpanded(id, expanded),
    onSuccess: (document) => client.setQueryData(settingsKeys.productSettings, document),
  });
  const chatProjectId = useChat((state) => state.workspaceId);
  const conversationId = useChat((state) => state.conversationId);
  const [focused, setFocused] = useState<{ projectId: string; conversationId: string }>();
  const selectedProject =
    focused?.conversationId === conversationId ? focused.projectId : (currentProjectId ?? chatProjectId);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const defaultExpanded = currentProjectId ?? chatProjectId ?? projects[0]?.id;
  const isExpanded = (projectId: string) =>
    toggled[projectId] ?? settings.data?.settings.workspaceExpansion?.[projectId] ?? projectId === defaultExpanded;
  const setExpanded = (id: string, expanded: boolean) => {
    setToggled((previous) => ({ ...previous, [id]: expanded }));
    saveExpansion.mutate({ id, expanded });
  };
  const activeKey = useChat((state) => {
    if (!state.workspaceId) return '';
    return sessionActionKey(state.workspaceId, {
      agent: state.agent,
      sessionId: state.sessionId ?? localSessionId(state.conversationId),
    });
  });
  return {
    selectedProject,
    saveError: saveExpansion.isError,
    activeKey,
    isExpanded,
    expand(projectId: string) {
      setExpanded(projectId, true);
    },
    toggle(projectId: string, searching = false) {
      const collapse = isExpanded(projectId);
      setFocused({ projectId, conversationId });
      if (!searching) setExpanded(projectId, !collapse);
    },
  };
}
function useSidebarSearch(controlled?: string, change?: (value: string) => void) {
  const [local, setLocal] = useState('');
  return [controlled ?? local, change ?? setLocal] as const;
}
function MoreSessions({ page }: { page?: SidebarProps['sessionPages'] }) {
  return page ? <LoadMoreSessions {...page} loading={page.loadingMore} /> : null;
}
function ExpansionSaveError({ visible, failed }: { visible: boolean; failed: boolean }) {
  if (!visible || !failed) return null;
  return (
    <p role="alert" className="px-3 py-1 text-xs text-destructive-foreground">
      展开状态未能保存，重开后可能恢复旧状态。请重新展开或收起一次。
    </p>
  );
}

/** 左栏只读取摘要与导航；原生会话写操作始终使用被点击行的完整身份。 */
export function Sidebar({
  pages,
  search: controlledSearch,
  onSearch,
  sessionPages,
  otherPages,
  projects,
  sessionsByProject,
  sessionErrorsByProject,
  onRetrySessions,
  otherSessions: extraSessions = EMPTY_SESSIONS,
  loadingOtherSessions = false,
  otherSessionsError,
  onShowOtherSessions,
  onAddProject,
  onNewSession,
  onSelectProject,
  onSelectSession,
  onManageProject,
  reveal,
  onOpenSettings,
  onOpenSessionSearch,
  onOpenArchive,
  onOpenConversation,
  loadingSessions = false,
  currentProjectId,
}: SidebarProps) {
  const collapsed = useUiPreferences((state) => state.sidebarCollapsed || state.sidebarAutoCollapsed);
  const selection = useSidebarSelection(projects, currentProjectId);
  const [search, setSearch] = useSidebarSearch(controlledSearch, onSearch);
  const query = search.trim().toLocaleLowerCase();
  const [showOtherSessions, setShowOtherSessions] = useState(false);
  const [managing, setManaging] = useState<ProjectSessionSelection | undefined>(undefined);
  const sortMode = useSessionOrder((state) => state.mode);
  const orders = useSessionOrder((state) => state.orders);
  const knownOrder = useSessionOrder((state) => state.known);
  const rememberOrder = useSessionOrder((state) => state.remember);
  const workspaceSessions = useWorkspaceSessions(sessionsByProject);
  const projectSessions = useMemo(
    () =>
      Object.fromEntries(
        projects.map((project) => [
          project.id,
          sortSessions(
            (workspaceSessions[project.id] ?? EMPTY_SESSIONS).filter((session) => session.projectId === project.id),
            sortMode,
            orders[project.id] ?? knownOrder[project.id],
          ),
        ]),
      ) as Record<string, WorkspaceSession[]>,
    [projects, workspaceSessions, sortMode, orders, knownOrder],
  );
  useEffect(() => {
    for (const [project, sessions] of Object.entries(projectSessions))
      rememberOrder(project, sessions.filter((session) => !session.local).map(sessionOrderKey), !!query);
  }, [projectSessions, rememberOrder, query]);
  const otherSessions = useMemo(
    () => unassignedSessions(sessionsByProject, extraSessions),
    [sessionsByProject, extraSessions],
  );
  const visible = useMemo(() => visibleProjects(projects, projectSessions, query), [projects, projectSessions, query]);
  const showOther = (show: boolean) => {
    setShowOtherSessions(show);
    onShowOtherSessions?.(show);
    if (show && collapsed) useUiPreferences.getState().setSidebarCollapsed(false);
  };
  return (
    <nav aria-label="项目与会话" className="flex h-full min-h-0 flex-col bg-sidebar p-2 text-foreground">
      <SidebarBrand collapsed={collapsed} />
      <div className="flex shrink-0 flex-col gap-0.5 pt-1">
        <NewSessionMenu
          projects={projects}
          currentProjectId={selection.selectedProject}
          onNewSession={onNewSession}
          onAddProject={() => onAddProject()}
          collapsed={collapsed}
        />
        {pages}
        <SidebarMore
          collapsed={collapsed}
          showOtherSessions={showOtherSessions}
          setShowOtherSessions={showOther}
          onOpenSessionSearch={onOpenSessionSearch}
          onOpenArchive={onOpenArchive}
        />
      </div>
      <SidebarWorkspaces
        collapsed={collapsed}
        query={search}
        changeQuery={setSearch}
        addProject={() => onAddProject()}
      />
      <ExpansionSaveError visible={!collapsed} failed={selection.saveError} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!collapsed && (
          <>
            <WorkspaceListNotice
              projects={projects}
              visibleCount={visible.length}
              incomplete={Boolean(sessionPages?.hasMore)}
              addProject={() => onAddProject()}
            />
            <ul className="flex flex-col gap-0.5">
              {visible.map(({ project, sessions }) => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  sessions={sessions}
                  searching={Boolean(query)}
                  expanded={Boolean(query) || selection.isExpanded(project.id)}
                  current={selection.selectedProject === project.id}
                  loading={loadingSessions}
                  incomplete={Boolean(sessionPages?.hasMore)}
                  failures={sessionErrorsByProject?.[project.id] ?? EMPTY_FAILURES}
                  retry={onRetrySessions ? () => onRetrySessions(project.id) : undefined}
                  running={projectSessions[project.id]!.some((session) => session.running)}
                  activeKey={selection.activeKey}
                  toggle={() => {
                    onSelectProject?.(project.id);
                    selection.toggle(project.id, Boolean(query));
                  }}
                  newSession={(id, agent) => {
                    selection.expand(id);
                    onNewSession?.(id, agent);
                  }}
                  selectSession={(session) => {
                    if (session.conversationId)
                      (onOpenConversation ?? useChat.getState().openConversation)(session.conversationId);
                    else onSelectSession?.(project.id, session);
                  }}
                  manageSession={(session, action, archived) =>
                    setManaging({ workspaceId: project.id, session, action, archived })
                  }
                  onManageProject={onManageProject}
                  reveal={reveal}
                />
              ))}
            </ul>
            <MoreSessions page={sessionPages} />
            {showOtherSessions && (
              <>
                <SidebarOtherSessions
                  sessions={otherSessions.filter((session) => matchesSession(session, query))}
                  activeKey={selection.activeKey}
                  addProject={onAddProject}
                  loading={loadingOtherSessions}
                  incomplete={Boolean(otherPages?.hasMore)}
                  error={otherSessionsError}
                />
                <MoreSessions page={otherPages} />
              </>
            )}
          </>
        )}
      </div>
      <SidebarFooter collapsed={collapsed} onOpenSettings={onOpenSettings} />
      {managing && (
        <ProjectSessionDialog
          key={JSON.stringify([
            managing.workspaceId,
            managing.session.agent,
            managing.session.sessionId,
            managing.action,
          ])}
          selected={managing}
          sessions={projectSessions[managing.workspaceId] ?? EMPTY_SESSIONS}
          close={() => setManaging(undefined)}
        />
      )}
    </nav>
  );
}
