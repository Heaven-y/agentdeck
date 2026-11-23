import { projectsApi, projectsKeys } from '../features/projects/api';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState, type MutableRefObject } from 'react';
import type { AgentKind, SessionSummary } from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import { useChat } from '../features/chat/state/chat-store';

import { TopBar } from './layout/TopBar';
import { useProductSettings } from '../features/settings/general/use-product-settings';
import { useUiPreferences } from '../ui/appearance/ui-preferences';
import { useCommandPalette } from './navigation/use-command-palette';
import type { PaletteActions } from './navigation/CommandPalette';
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

const SettingsDialog = lazy(() => import('../features/settings/SettingsDialog'));
const CommandPalette = lazy(() => import('./navigation/CommandPalette'));
const PluginManager = lazy(() => import('../features/plugins/PluginManager'));
const ArchivedSessionsPage = lazy(() => import('../features/sessions/list/ArchivedSessionsPage'));

function OpenPluginManager({ opened, close }: { opened: boolean; close(): void }) {
  return (
    opened && (
      <Suspense fallback={<p role="status">正在打开插件管理…</p>}>
        <PluginManager onClose={close} />
      </Suspense>
    )
  );
}

function OpenPalette({
  opened,
  workspace,
  workspaces,
  actions,
  close,
}: {
  opened: boolean;
  workspace?: Workspace;
  workspaces?: Workspace[];
  actions: PaletteActions;
  close(): void;
}) {
  return (
    opened && (
      <Suspense
        fallback={
          <p role="status" className="p-3 text-sm">
            正在打开命令面板…
          </p>
        }
      >
        <CommandPalette
          key={workspace?.id ?? 'none'}
          workspaces={workspaces ?? []}
          workspace={workspace}
          actions={actions}
          close={close}
        />
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
  const palette = useCommandPalette();
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
  const settings = useSettingsWorkspace(!activePlugin && !archiveOpen);
  const showPlugin = (id?: string) =>
    settings.navigate(() => {
      setArchiveOpen(false);
      plugins.show(id);
    });
  const showArchive = () =>
    settings.navigate(() => {
      plugins.show(undefined);
      setArchiveOpen(true);
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
      plugins.show(undefined);
      useChat.getState().openConversation(id);
    });
  const openSession = (targetProject: string, session: SessionSummary) =>
    settings.navigate(() => {
      setArchiveOpen(false);
      plugins.show(undefined);
      if (useChat.getState().workspaceId !== targetProject)
        useChat.getState().selectWorkspace(targetProject, { restore: false });
      void useChat.getState().openSession(session);
    });
  const startSession = (targetProject: string, agent?: AgentKind) =>
    settings.navigate(() => {
      setArchiveOpen(false);
      plugins.show(undefined);
      const chat = useChat.getState();
      if (chat.workspaceId !== targetProject) chat.selectWorkspace(targetProject, { restore: false });
      useChat.getState().newSession(agent);
    });

  return (
    <div className="flex h-full min-w-[800px] flex-col">
      <DesktopTitleBar />
      <OpenPluginManager opened={plugins.managerOpen} close={() => plugins.setManagerOpen(false)} />
      <ProjectDialogs
        adding={addingProject}
        managing={managingProject}
        closeAdd={() => setAddingProject(undefined)}
        closeManage={() => setManagingProject(undefined)}
      />
      <OpenPalette
        opened={palette.opened}
        workspace={current}
        workspaces={projects.data}
        close={palette.close}
        actions={{
          plugins: plugins.commands.map((command) => ({
            ...command,
            run: () =>
              settings.navigate(() => {
                if (!command.run()) return false;
                setArchiveOpen(false);
                return true;
              }),
          })),
          conversation: () =>
            settings.navigate(() => {
              setArchiveOpen(false);
              plugins.show(undefined);
            }),
          newSession: () => (current ? startSession(current.id) : false),
          openSession: (session) => (current ? openSession(current.id, session) : false),
          selectWorkspace: (id) =>
            settings.navigate(() => {
              setArchiveOpen(false);
              plugins.show(undefined);
              useChat.getState().selectWorkspace(id, { restore: false });
            }),
          settings: () => {
            // 命令面板先卸载并恢复其触发点，再记录设置页的返回焦点。
            requestAnimationFrame(settings.open);
            return true;
          },
        }}
      />
      <SettingsWorkspace
        opened={settings.opened}
        settings={<OpenSettings guardRef={settings.guardRef} close={settings.close} workspace={current} />}
      >
        <WorkspaceLayout
          dockOpen={sidebarVisible}
          dock={
            <ConversationSidebar workspace={current} open={sidebarVisible} close={dock.hide} settings={settings.open} />
          }
          navigation={
            <Sidebar
              pages={
                <PluginNavigation
                  plugins={plugins.list}
                  selected={plugins.selected}
                  open={showPlugin}
                  manage={() => plugins.setManagerOpen(true)}
                />
              }
              search={sessionSearch}
              onSearch={setSessionSearch}
              sessionPages={{ hasMore, loadingMore, more }}
              otherPages={others}
              projects={projects.data ?? []}
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
              onOpenCommands={palette.open}
              onOpenArchive={showArchive}
              onSelectSession={openSession}
              reveal={reveal}
            />
          }
        >
          <div className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col">
            <ConversationTabs projects={projects.data ?? []} visible={conversationVisible} onOpen={openConversation} />
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
                builtinPlugins={plugins.builtinPlugins}
                project={current}
                close={() => showPlugin(undefined)}
                command={plugins.command}
              />
              {archiveOpen && (
                <Suspense
                  fallback={
                    <p role="status" className="p-4">
                      正在打开归档会话…
                    </p>
                  }
                >
                  <ArchivedSessionsPage
                    projects={projects.data ?? []}
                    close={closeArchive}
                    addProject={setAddingProject}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </WorkspaceLayout>
      </SettingsWorkspace>
      <NativeInteractionInbox />
    </div>
  );
}
