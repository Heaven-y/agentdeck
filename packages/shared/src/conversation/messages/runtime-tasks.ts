import type { AgentKind } from '../agents';

export type RuntimeTaskSnapshot = {
  id: string;
  sessionId: string;
  parentTaskId?: string;
  name?: string;
  kind?: string;
  background?: boolean;
  ambient?: boolean;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  canStop: boolean;
};
export type RuntimeTasksState = {
  workspaceId: string;
  agent: AgentKind;
  sessionId: string;
  runtimeId: string;
  tasks: RuntimeTaskSnapshot[];
  closed?: boolean;
  error?: string;
  stoppingTaskIds?: string[];
};
export function taskActive(task: RuntimeTaskSnapshot): boolean {
  return !task.ambient && (task.status === 'running' || task.status === 'waiting');
}
