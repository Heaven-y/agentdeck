import { projectsApi, projectsKeys } from '../features/projects/api';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState, type MutableRefObject } from 'react';
import type { AgentKind, SessionSummary } from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import { useChat } from '../features/chat/state/chat-store';

import { TopBar } from './layout/TopBar';
import { useProductSettings } from '../features/settings/general/use-product-settings';
import { useUiPreferences } from '../ui/appearance/ui-preferences';
import { useWorkbenchShortcuts } from './navigation/use-shortcuts';
import type { WorkspaceSession } from '../features/sessions/list/workspace-sessions';
import { EnvironmentSummary } from '../features/settings/environment/EnvironmentReport';
import { Sidebar } from './sidebar/Sidebar';
import { SessionPane } from './layout/SessionPane';
import { ConversationSidebar } from './sidebar/ConversationSidebar';
import { WorkspaceLayout } from './layout/WorkspaceLayout';
import { SettingsWorkspace, useSettingsWorkspace } from './layout/SettingsWorkspace';
import type { SettingsLeave } from '../features/settings/navigation/settings-navigation';
import { useProjectNavigation } from './navigation/use-project-navigation';
import { desktopPathOpener, revealLabel } from '../lib/desktop-bridge';
import { useOtherSessions, useProjectSessions } from '../features/projects/use-project-sessions';
import { useConversationSidebar } from './sidebar/use-conversation-sidebar';
import { ConversationTabs } from '../features/chat/tabs/ConversationTabs';
import { AddProjectDialog } from '../features/projects/AddProjectDialog';
import { ProjectManageDialog } from '../features/projects/ProjectManageDialog';
import type { ProjectDraft, ProjectManageAction } from '../features/projects/project-management';
import { PluginNavigation } from '../features/plugins/PluginNavigation';
import { PluginWorkspace } from '../features/plugins/PluginWorkspace';
import { usePluginPages } from '../features/plugins/use-plugin-pages';
import { DesktopTitleBar } from './layout/DesktopTitleBar';
import { NativeInteractionInbox } from '../features/chat/interactions/InteractionCard';
import { PluginHostContext } from '../features/plugins/plugin-host';

const UsagePage = lazy(() => import('../features/usage/UsagePage'));
const SettingsDialog = lazy(() => import('../features/settings/SettingsDialog'));
const SessionSearch = lazy(() => import('./navigation/SessionSearch'));
const PluginManager = lazy(() => import('../features/plugins/PluginManager'));
const ArchivedSessionsPage = lazy(() => import('../features/sessions/list/ArchivedSessionsPage'));
const EMPTY_PROJECTS: Workspace[] = [];

function OpenPluginManager({
  opened,
  close,
  run,
}: {
  opened: boolean;
  close(): void;
  run(pluginId: string, command: string): boolean;
}) {
  return (
    opened && (
      <Suspense fallback={<p role="status">正在打开插件管理…</p>}>
        <PluginManager onClose={close} run={run} />
      </Suspense>
    )
  );
}

function OpenSessionSearch({
  opened,
  projects,
  open,
  close,
}: {
  opened: boolean;
  projects: Workspace[];
  open(projectId: string, session: WorkspaceSession): boolean;
  close(): void;
}) {
  return (
    opened && (
      <Suspense fallback={null}>
        <SessionSearch projects={projects} open={open} close={close} />
      </Suspense>
    )
  );
}

function OpenSettings({
  guardRef,
  close,
  workspace,
}: {
  guardRef: MutableRefObject<SettingsLeave>;
  close(): void;
  workspace?: Pick<Workspace, 'id' | 'name'>;
}) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-sm">
          正在打开设置…
        </p>
      }
    >
      <SettingsDialog guardRef={guardRef} onClose={close} workspace={workspace} />
    </Suspense>
  );
}

function ProjectDialogs({
  adding,
  managing,
  closeAdd,
  closeManage,
}: {
  adding?: ProjectDraft;
  managing?: { project: Workspace; action: ProjectManageAction };
  closeAdd(): void;
  closeManage(): void;
}) {
  return (
    <>
      {adding && <AddProjectDialog initialDir={adding.dir} initialName={adding.name} onClose={closeAdd} />}
      {managing && <ProjectManageDialog {...managing} onClose={closeManage} />}
    </>
  );
}

/** 打开项目目录失败时用会话横幅报错，不静默吞掉系统拒绝的原因。 */
function revealProjectDir(openPath: (target: string) => Promise<boolean>) {
  return (project: Workspace) => ({
    label: revealLabel(),
    open: () => {
      void openPath(project.dir).catch((error: unknown) => {
        useChat.setState({ banner: error instanceof Error ? error.message : '无法打开项目目录。' });
      });
    },
  });
}

/**
 * 工作区导航贯穿左列；会话与插件使用中间主区，右侧上下文按需打开。
 */
export function App() {
  const [searchOpened, setSearchOpened] = useState(false);
  const theme = useUiPreferences((state) => state.theme);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const productSettings = useProductSettings();
  const setDefaults = useChat((s) => s.setDefaults);
  useEffect(() => {
    if (productSettings.data) setDefaults(productSettings.data.settings);
  }, [productSettings.data, setDefaults]);
  const plugins = usePluginPages();
  const activePlugin = plugins.active;
  const openPath = desktopPathOpener();
  const reveal = useMemo(() => (openPath ? revealProjectDir(openPath) : undefined), [openPath]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const settings = useSettingsWorkspace(!activePlugin && !archiveOpen && !usageOpen);
  const showPlugin = (id?: string, page?: string) =>
    settings.navigate(() => {
      setArchiveOpen(false);
      setUsageOpen(false);
      plugins.show(id, page);
    });
  const runPluginCommand = (pluginId: string, command: string) =>
    settings.navigate(() => {
      const accepted = plugins.run(pluginId, command);
      if (accepted) {
        setArchiveOpen(false);
        setUsageOpen(false);
      }
      return accepted;
    });
  const showArchive = () =>
    settings.navigate(() => {
      plugins.show(undefined);
      setArchiveOpen(true);
      setUsageOpen(false);
    });
  const showUsage = () =>
    settings.navigate(() => {
      plugins.show(undefined);
      setArchiveOpen(false);
      setUsageOpen(true);
    });
  const closeArchive = () => {
    setArchiveOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('button[aria-label="更多"]')?.focus());
  };
  const [addingProject, setAddingProject] = useState<ProjectDraft>();
  const [managingProject, setManagingProject] = useState<{ project: Workspace; action: ProjectManageAction }>();
  const dock = useConversationSidebar();
  const conversationVisible = settings.conversationVisible;
  const conversationId = useChat((s) => s.conversationId);
  useEffect(() => {
    useChat.setState({ conversationVisible, ...(conversationVisible ? { unread: false } : {}) });
  }, [conversationVisible, conversationId]);
  const sidebarVisible = dock.open && conversationVisible;
  const projects = useQuery({
    queryKey: projectsKeys.workspaces,
    queryFn: ({ signal }) => projectsApi.listWorkspaces(signal),
  });
  const projectId = useChat((s) => s.workspaceId);
  const projectList = projects.data ?? EMPTY_PROJECTS;
  useProjectNavigation(projects.data);
  const current = projects.data?.find((project) => project.id === projectId);
  const [sessionSearch, setSessionSearch] = useState('');
  const {
    sessionsByProject,
    loading: sessionsLoading,
    errorsByProject,
    retryProject,
    hasMore,
    loadingMore,
    more,
  } = useProjectSessions(projects.data, sessionSearch);
  const [showOtherSessions, setShowOtherSessions] = useState(false);
  const others = useOtherSessions(showOtherSessions, sessionSearch);
  const openConversation = (id: string) =>
    settings.navigate(() => {
      setArchiveOpen(false);
      setUsageOpen(false);
      plugins.show(undefined);
      useChat.getState().openConversation(id);
    });
  const openSession = (targetProject: string, session: SessionSummary) =>
    settings.navigate(() => {
      setArchiveOpen(false);
      setUsageOpen(false);
      plugins.show(undefined);
      if (useChat.getState().workspaceId !== targetProject)
        useChat.getState().selectWorkspace(targetProject, { restore: false });
      void useChat.getState().openSession(session);
    });
  const startSession = (targetProject: string, agent?: AgentKind) =>
    settings.navigate(() => {
      setArchiveOpen(false);
      setUsageOpen(false);
      plugins.show(undefined);
      const chat = useChat.getState();
      if (chat.workspaceId !== targetProject) chat.selectWorkspace(targetProject, { restore: false });
      useChat.getState().newSession(agent);
    });

  const cycleTab = (direction: number) => {
    const state = useChat.getState();
    const index = state.tabIds.indexOf(state.conversationId);
    const next = state.tabIds[(index + direction + state.tabIds.length) % state.tabIds.length];
    if (next) openConversation(next);
  };
  useWorkbenchShortcuts({
    search: () => setSearchOpened(true),
    newSession: () => {
      if (current) startSession(current.id);
    },
    nextTab: () => cycleTab(1),
    previousTab: () => cycleTab(-1),
    closeTab: () =>
      settings.navigate(() => {
        const state = useChat.getState();
        state.closeConversationTab(state.conversationId);
      }),
    focusComposer: () =>
      settings.navigate(() => {
        setArchiveOpen(false);
        setUsageOpen(false);
        plugins.show(undefined);
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus());
      }),
    settings: settings.open,
    sidebar: () => {
      const state = useUiPreferences.getState();
      state.setSidebarCollapsed(!state.sidebarCollapsed);
    },
  });

  return (
    <PluginHostContext.Provider
      value={{
        plugins: plugins.enabledPlugins,
        open: (plugin, page) => showPlugin(plugin.manifest.id, page.id),
        run: (plugin, command) => {
          settings.navigate(() => plugins.run(plugin.manifest.id, command));
        },
      }}
    >
      <div className="flex h-full min-w-[800px] flex-col">
        <DesktopTitleBar />
        <OpenPluginManager
          opened={plugins.managerOpen}
          close={() => plugins.setManagerOpen(false)}
          run={runPluginCommand}
        />
        <ProjectDialogs
          adding={addingProject}
          managing={managingProject}
          closeAdd={() => setAddingProject(undefined)}
          closeManage={() => setManagingProject(undefined)}
        />
        <OpenSessionSearch
          opened={searchOpened}
          projects={projectList}
          close={() => setSearchOpened(false)}
          open={(projectId, session) =>
            session.conversationId ? openConversation(session.conversationId) : openSession(projectId, session)
          }
        />
        <SettingsWorkspace
          opened={settings.opened}
          settings={<OpenSettings guardRef={settings.guardRef} close={settings.close} workspace={current} />}
        >
          <WorkspaceLayout
            dockOpen={sidebarVisible}
            dock={
              <ConversationSidebar
                workspace={current}
                open={sidebarVisible}
                close={dock.hide}
                settings={settings.open}
              />
            }
            navigation={
              <Sidebar
                pages={
                  <PluginNavigation
                    plugins={plugins.list}
                    selected={plugins.selected}
                    selectedPage={plugins.activePage}
                    open={showPlugin}
                    manage={() => plugins.setManagerOpen(true)}
                  />
                }
                search={sessionSearch}
                onSearch={setSessionSearch}
                sessionPages={{ hasMore, loadingMore, more }}
                otherPages={others}
                projects={projectList}
                sessionsByProject={sessionsByProject}
                sessionErrorsByProject={errorsByProject}
                onRetrySessions={retryProject}
                otherSessions={others.sessions}
                loadingOtherSessions={others.loading}
                otherSessionsError={others.error}
                onShowOtherSessions={setShowOtherSessions}
                loadingSessions={sessionsLoading}
                currentProjectId={current?.id}
                onAddProject={(initial) => setAddingProject(initial ?? {})}
                onManageProject={(project, action) => setManagingProject({ project, action })}
                onNewSession={startSession}
                onOpenConversation={openConversation}
                onOpenSettings={settings.open}
                onOpenSessionSearch={() => setSearchOpened(true)}
                onOpenArchive={showArchive}
                onOpenUsage={showUsage}
                usageOpen={usageOpen}
                onSelectSession={openSession}
                reveal={reveal}
              />
            }
          >
            <div className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col">
              <ConversationTabs projects={projectList} visible={conversationVisible} onOpen={openConversation} />
              <div className="min-h-0 flex-1">
                <div
                  hidden={!conversationVisible}
                  inert={!conversationVisible}
                  className={conversationVisible ? 'flex h-full min-h-0 flex-col' : 'hidden'}
                >
                  <div
                    id="conversation-panel"
                    role="tabpanel"
                    aria-label="会话内容"
                    className="flex min-h-0 flex-1 flex-col"
                  >
                    <TopBar workspace={current} sidebarOpen={dock.open} onToggleSidebar={dock.toggle} />
                    <EnvironmentSummary onOpenSettings={settings.open} />
                    <SessionPane
                      project={current}
                      pending={projects.isPending}
                      error={projects.error}
                      onAddProject={() => setAddingProject({})}
                    />
                  </div>
                </div>
                <PluginWorkspace
                  plugin={activePlugin}
                  enabledPlugins={plugins.enabledPlugins}
                  project={current}
                  close={() => {
                    const returning = plugins.activePage?.location === 'settings';
                    showPlugin(undefined);
                    if (returning) settings.open();
                  }}
                  page={plugins.activePage}
                  invocations={plugins.invocations}
                  delivered={plugins.delivered}
                  hidden={settings.opened}
                />
                {usageOpen && (
                  <Suspense
                    fallback={
                      <p role="status" className="p-4">
                        正在打开用量…
                      </p>
                    }
                  >
                    <UsagePage projects={projectList} close={() => setUsageOpen(false)} />
                  </Suspense>
                )}
                {archiveOpen && (
                  <Suspense
                    fallback={
                      <p role="status" className="p-4">
                        正在打开归档会话…
                      </p>
                    }
                  >
                    <ArchivedSessionsPage projects={projectList} close={closeArchive} addProject={setAddingProject} />
                  </Suspense>
                )}
              </div>
            </div>
          </WorkspaceLayout>
        </SettingsWorkspace>
        <NativeInteractionInbox />
      </div>
    </PluginHostContext.Provider>
  );
}
