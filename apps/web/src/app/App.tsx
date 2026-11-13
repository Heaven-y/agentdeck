import { projectsApi, projectsKeys } from '../features/projects/api';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useLayoutEffect, useState, type MutableRefObject } from 'react';
import type { AgentKind, SessionSummary } from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import { useChat } from '../features/chat/chat-store';

import { TopBar } from './TopBar';
import { useProductSettings } from '../features/settings/use-product-settings';
import { useUiPreferences } from '../ui/ui-preferences';
import { useCommandPalette } from './use-command-palette';
import type { PaletteActions } from './CommandPalette';
import { EnvironmentSummary } from '../features/settings/EnvironmentReport';
import { Sidebar } from './Sidebar';
import { SessionPane } from './SessionPane';
import { ConversationSidebar } from './ConversationSidebar';
import { WorkspaceLayout } from './WorkspaceLayout';
import { SettingsWorkspace, useSettingsWorkspace } from './SettingsWorkspace';
import type { SettingsLeave } from '../features/settings/use-model-settings';
import { useProjectNavigation } from './use-project-navigation';
import { useOtherSessions, useProjectSessions } from '../features/projects/use-project-sessions';
import { useConversationSidebar } from './use-conversation-sidebar';
import { ConversationTabs } from '../features/chat/ConversationTabs';
import { AddProjectDialog } from '../features/projects/AddProjectDialog';
import { BindServerDialog } from '../builtin-plugins/ssh-console/legacy/BindServerDialog';
import { ProjectManageDialog } from '../features/projects/ProjectManageDialog';
import type { ProjectDraft, ProjectManageAction } from '../features/projects/project-management';
import { PluginNavigation } from '../features/plugins/PluginNavigation';
import { PluginWorkspace } from '../features/plugins/PluginWorkspace';
import { usePluginPages } from '../features/plugins/use-plugin-pages';
import { DesktopTitleBar } from './DesktopTitleBar';
import { NativeInteractionInbox } from '../features/chat/InteractionCard';

const SettingsDialog = lazy(() => import('../features/settings/SettingsDialog'));
const CommandPalette = lazy(() => import('./CommandPalette'));
const PluginManager = lazy(() => import('../features/plugins/PluginManager'));
const ArchivedSessionsPage = lazy(() => import('../features/sessions/ArchivedSessionsPage'));

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
  project,
  projects,
  guardRef,
  close,
}: {
  project?: Workspace;
  projects?: Workspace[];
  guardRef: MutableRefObject<SettingsLeave>;
  close(): void;
}) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-sm">
          正在打开设置…
        </p>
      }
    >
      <SettingsDialog project={project} projects={projects} guardRef={guardRef} onClose={close} />
    </Suspense>
  );
}

function ProjectDialogs({
  adding,
  binding,
  managing,
  closeAdd,
  closeBind,
  closeManage,
}: {
  adding?: ProjectDraft;
  binding?: Workspace;
  managing?: { project: Workspace; action: ProjectManageAction };
  closeAdd(): void;
  closeBind(): void;
  closeManage(): void;
}) {
  return (
    <>
      {adding && <AddProjectDialog initialDir={adding.dir} initialName={adding.name} onClose={closeAdd} />}
      {binding && <BindServerDialog project={binding} onClose={closeBind} />}
      {managing && <ProjectManageDialog {...managing} onClose={closeManage} />}
    </>
  );
}

/** 工作区导航贯穿左列；会话与插件使用中间主区，右侧上下文按需打开。 */
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
  // 绑定服务器要拿到具体的项目对象，不能只记一个开关。
  const [bindingProject, setBindingProject] = useState<Workspace | undefined>(undefined);
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
        binding={bindingProject}
        managing={managingProject}
        closeAdd={() => setAddingProject(undefined)}
        closeBind={() => setBindingProject(undefined)}
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
        settings={
          <OpenSettings
            project={current}
            projects={projects.data}
            guardRef={settings.guardRef}
            close={settings.close}
          />
        }
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
              onBindServer={setBindingProject}
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
