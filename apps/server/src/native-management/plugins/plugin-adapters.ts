import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativePluginAction, NativePluginCatalog } from '@agentdeck/shared/settings';
import { antigravityPlugins } from '../../agents/antigravity/configuration/plugins';
import { claudePlugins } from '../../agents/claude/configuration/plugins';
import { codexPlugins } from '../../agents/codex/configuration/plugins';
import { resolveCodexCommand } from '../../agents/codex/run/launch';
import { resolveLocalCommand, type ResolvedCommand } from '../../platform/process/executable';
import { NativeManagementError } from '../errors';
import type { PluginContext, PluginInventory } from './plugin-types';

type PluginAdapter = {
  read(context: PluginContext): Promise<PluginInventory>;
  resolve(env: NodeJS.ProcessEnv): ResolvedCommand | Promise<ResolvedCommand>;
  manifestFiles: readonly string[];
  installScopes: NativePluginCatalog['installScopes'];
  installSelector: boolean;
  verbs: Partial<Record<NativePluginAction, string>>;
};

// 新 CLI 须显式登记；没有原生插件适配时可声明 undefined，不沿用其他 CLI 的指令或来源。
const adapters: Record<AgentKind, PluginAdapter | undefined> = {
  claude: {
    read: claudePlugins,
    resolve: (env) => resolveLocalCommand('claude', env),
    manifestFiles: ['.claude-plugin/plugin.json'],
    installScopes: ['user', 'project', 'local'],
    installSelector: true,
    verbs: {
      install: 'install',
      uninstall: 'uninstall',
      enable: 'enable',
      disable: 'disable',
      update: 'update',
      validate: 'validate',
      configure: 'configure',
      'marketplace-add': 'add',
      'marketplace-remove': 'remove',
      'marketplace-refresh': 'update',
    },
  },
  codex: {
    read: codexPlugins,
    resolve: (env) => resolveCodexCommand({ env }),
    // 离线目录已用同一份 manifest 确定版本和描述，无需重读。
    manifestFiles: [],
    installScopes: ['user'],
    installSelector: true,
    verbs: {
      install: 'add',
      uninstall: 'remove',
      'marketplace-add': 'add',
      'marketplace-remove': 'remove',
      'marketplace-refresh': 'upgrade',
    },
  },
  antigravity: {
    read: antigravityPlugins,
    resolve: (env) => resolveLocalCommand('agy', env),
    manifestFiles: ['plugin.json', '.antigravity-plugin/plugin.json'],
    installScopes: ['user'],
    installSelector: false,
    verbs: { install: 'install', uninstall: 'uninstall', enable: 'enable', disable: 'disable', validate: 'validate' },
  },
};

export function pluginAdapter(agent: AgentKind): PluginAdapter {
  const adapter = Object.hasOwn(adapters, agent) ? adapters[agent] : undefined;
  if (!adapter) throw new NativeManagementError('unsupported_action');
  return adapter;
}
