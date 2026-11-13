import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import type { SettingsLeave } from './use-model-settings';
import { guardSettingsNavigation, leaveSettings } from './settings-navigation';

export type SettingsPage =
  AgentKind | 'general' | 'environment' | 'skills' | 'mcp' | 'plugins' | 'files' | 'memory' | 'launch';
export type SettingsPageProps = {
  onClose(): void;
  onNative?(agent: AgentKind): void;
  onLaunchEnvironment?(agent: AgentKind): void;
  page?: SettingsPage;
  onPageChange?(page: SettingsPage): void;
  initialPage?: SettingsPage;
  projectId?: string;
  project?: Workspace;
  projects?: Workspace[];
  guardRef?: MutableRefObject<SettingsLeave>;
};
export const agents: AgentKind[] = ['claude', 'codex', 'antigravity'];
export const isModelPage = (page: SettingsPage): page is AgentKind => agents.includes(page as AgentKind);
export const resourceCategory = { skills: 'skills', mcp: 'mcp', plugins: 'plugins', files: 'all' } as const;
function projectChoices(props: SettingsPageProps) {
  if (props.projects?.length) return props.projects;
  return props.project ? [props.project] : [];
}
function useSelection(props: SettingsPageProps) {
  const [localPage, setPage] = useState<SettingsPage>(props.initialPage ?? 'claude');
  const page = props.page ?? localPage;
  const [agent, setAgent] = useState<AgentKind>(isModelPage(page) ? page : 'claude');
  const [scope, setScope] = useState(props.project?.id ?? props.projectId ?? '');
  const choices = projectChoices(props);
  const selectedProject = choices.find((entry) => entry.id === scope);
  const currentAgent = isModelPage(page) ? page : agent;
  const changePage = (next: SettingsPage) => {
    setPage(next);
    props.onPageChange?.(next);
  };
  return { page, currentAgent, selectedProject, choices, setScope, setAgent, changePage };
}
function usePageGuards(page: SettingsPage, outerGuardRef?: MutableRefObject<SettingsLeave>) {
  const [guards] = useState(() => new Map<symbol, SettingsLeave>());
  const formGuardRef = useRef<SettingsLeave>(leaveSettings);
  useLayoutEffect(() => {
    if (!isModelPage(page) && page !== 'general') return;
    const key = Symbol();
    guards.set(key, (action) => formGuardRef.current(action));
    return () => {
      guards.delete(key);
      formGuardRef.current = leaveSettings;
    };
  }, [guards, page]);
  useLayoutEffect(() => {
    if (!outerGuardRef) return;
    outerGuardRef.current = (action) => guardSettingsNavigation(guards, action);
    return () => {
      outerGuardRef.current = leaveSettings;
    };
  }, [outerGuardRef, guards]);
  const leave: SettingsLeave = (action) => guardSettingsNavigation(guards, action);
  return { guards, formGuardRef, leave };
}
export function useSettingsPage(props: SettingsPageProps) {
  const selection = useSelection(props);
  const { page, currentAgent, changePage, setAgent } = selection;
  const guard = usePageGuards(page, props.guardRef);
  const select = (next: SettingsPage) => {
    if (next !== page) guard.leave(() => changePage(next));
  };
  const selectAgent = (next: AgentKind) => {
    if (next === currentAgent) return;
    guard.leave(() => {
      setAgent(next);
      if (isModelPage(page)) changePage(next);
    });
  };
  const shortcut = (next: 'files' | 'launch', callback?: (agent: AgentKind) => void) => {
    if (callback) callback(currentAgent);
    else {
      setAgent(currentAgent);
      changePage(next);
    }
  };
  return {
    ...selection,
    ...guard,
    select,
    selectAgent,
    openNative: () => shortcut('files', props.onNative),
    openLaunch: () => shortcut('launch', props.onLaunchEnvironment),
  };
}
export type SettingsPageState = ReturnType<typeof useSettingsPage>;
