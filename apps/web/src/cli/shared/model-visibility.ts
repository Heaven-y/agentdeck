import type { AgentKind, AntigravityConnection } from '@agentdeck/shared/conversation';
import type { ModelVisibilityKey } from '@agentdeck/shared/settings';

/** 旧的 AGY 可见范围无法判断来源，不挪给其中一种连接。 */
export function modelVisibilityKey(
  agent: AgentKind,
  connection?: AntigravityConnection,
): ModelVisibilityKey | undefined {
  if (agent !== 'antigravity') return agent;
  return connection ? `antigravity-${connection}` : undefined;
}
