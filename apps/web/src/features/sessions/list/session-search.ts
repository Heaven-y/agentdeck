import type { SessionSummary } from '@agentdeck/shared/conversation';

const names = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity AGY' };
export function matchesSessionSearch(session: SessionSummary, query: string, project = '') {
  return `${session.title} ${session.sessionId} ${session.directory ?? ''} ${project} ${names[session.agent]}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}
