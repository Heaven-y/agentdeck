import type { AgentKind } from '@agentdeck/shared/conversation';
export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export const AGENT_FULL_NAMES: Record<AgentKind, string> = { ...AGENT_LABELS, claude: 'Claude Code' };

const EFFORT_LABELS: Record<string, string> = {
  auto: '自动',
  none: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '超高',
};
export const effortLabel = (value = '') => EFFORT_LABELS[value] ?? value;
