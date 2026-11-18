import { AGENT_KINDS, type AgentKind } from '@agentdeck/shared/conversation';
import type { LocalExecutable } from '../../platform/process/executable';

/** 同一个程序名用于查找安装、探测以及登记该 CLI 的原生进程占用。 */
export const cliExecutables = {
  claude: 'claude',
  codex: 'codex',
  antigravity: 'agy',
} satisfies Record<AgentKind, LocalExecutable>;
export const agentForExecutable = (command: string) => AGENT_KINDS.find((agent) => cliExecutables[agent] === command);
