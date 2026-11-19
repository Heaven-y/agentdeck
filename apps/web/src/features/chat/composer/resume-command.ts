import type { AgentKind } from '@agentdeck/shared/conversation';

export const RESUME_COMMAND = 'resume';
export const RESUME_SEARCH_LIMIT = 200;
export const RESUME_ALIASES: Record<AgentKind, readonly string[]> = {
  antigravity: ['conversation', 'switch'],
  claude: ['continue'],
  codex: [],
};

export function isResumeName(name: string, agent: AgentKind) {
  const token = name.toLowerCase();
  return token === RESUME_COMMAND || RESUME_ALIASES[agent].includes(token);
}

/** 只识别消息开头的整个命令词；普通文字、路径和其他斜杠不拦截。 */
export function resumeArgument(text: string, agent: AgentKind): string | undefined {
  const input = text.trim();
  const token = /^\/([^\s/]+)(?=\s|$)/u.exec(input)?.[1];
  return token && isResumeName(token, agent) ? input.slice(token.length + 1) : undefined;
}

export function resumeSuggestionMatches(query: string, agent: AgentKind) {
  const prefix = query.toLowerCase();
  return RESUME_COMMAND.startsWith(prefix) || RESUME_ALIASES[agent].some((name) => name.startsWith(prefix));
}
