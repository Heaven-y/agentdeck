import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { isAgentKind, type AgentKind } from '@agentdeck/shared/conversation';
import type { SettingsLeave } from './settings-navigation';
import { guardSettingsNavigation, leaveSettings } from './settings-navigation';

import type { SettingsPage } from './page-registry';
export type SettingsPageProps = {
  onClose(): void;
  onNative?(agent: AgentKind): void;
  onLaunchEnvironment?(agent: AgentKind): void;
  page?: SettingsPage;
  onPageChange?(page: SettingsPage): void;
  initialPage?: SettingsPage;
  guardRef?: MutableRefObject<SettingsLeave>;
};
function useSelection(props: SettingsPageProps) {
  const [localPage, setPage] = useState<SettingsPage>(props.initialPage ?? 'claude');
  const page = props.page ?? localPage;
  const [agent, setAgent] = useState<AgentKind>(isAgentKind(page) ? page : 'claude');
  const currentAgent = isAgentKind(page) ? page : agent;
  const changePage = (next: SettingsPage) => {
    setPage(next);
    props.onPageChange?.(next);
  };
  return { page, currentAgent, setAgent, changePage };
}
function usePageGuards(page: SettingsPage, outerGuardRef?: MutableRefObject<SettingsLeave>) {
  const [guards] = useState(() => new Map<symbol, SettingsLeave>());
  const formGuardRef = useRef<SettingsLeave>(leaveSettings);
  useLayoutEffect(() => {
    if (!isAgentKind(page) && page !== 'general') return;
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
      if (isAgentKind(page)) changePage(next);
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
