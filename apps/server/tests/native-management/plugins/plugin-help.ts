import type { AgentKind } from '@agentdeck/shared/conversation';

const commands: Record<AgentKind, readonly string[]> = {
  claude: [
    'list',
    'marketplace',
    'install|i',
    'uninstall|remove',
    'enable',
    'disable',
    'update',
    'configure',
    'validate',
  ],
  codex: ['list', 'marketplace', 'add', 'remove'],
  antigravity: ['list', 'install', 'uninstall', 'enable', 'disable', 'validate'],
};

export function pluginHelp(agent: AgentKind, args: string[], unavailable = false): string | undefined {
  if (args.at(-1) !== '--help' || (args.at(-2) !== 'plugin' && args.at(-2) !== 'marketplace')) return undefined;
  const names = unavailable
    ? ['list']
    : args.at(-2) === 'marketplace'
      ? ['add', 'remove', agent === 'codex' ? 'upgrade' : 'update']
      : commands[agent];
  return ['Commands:', ...names.map((name) => `  ${name}    原生命令`)].join('\n');
}
