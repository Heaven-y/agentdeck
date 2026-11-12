import path from 'node:path';
import { claudeSkillConfig } from './skills';
import { readSkillConfig } from '../../../native-management/config';
import { claudePluginRecords, jsonResult, safeSelector, sourceLabel } from '../../../native-management/plugin-utils';
import {
  object,
  string,
  type PluginContext,
  type PluginInventory,
  type PluginMarketplace,
  type PluginRecord,
} from '../../../native-management/plugin-types';
import { NativeManagementError } from '../../../native-management/errors';
export async function claudePlugins(c: PluginContext): Promise<PluginInventory> {
  const result = await c.run(['plugin', 'list', '--json']);
  if (result.exitCode !== 0) throw new NativeManagementError('native_unavailable');
  const configs = await claudeSkillConfig(c);
  const base = path.resolve(c.env.CLAUDE_CONFIG_DIR || path.join(c.homeDir, '.claude'));
  const known = await readSkillConfig(path.join(base, 'plugins/known_marketplaces.json'), 'user');
  const marketplaces: PluginMarketplace[] = [];
  for (const config of configs)
    for (const [name, value] of Object.entries(object(config.data.extraKnownMarketplaces))) {
      const record = object(value),
        local = object(known.data[name]);
      marketplaces.push({
        name,
        scope: config.scope,
        source: sourceLabel(record.source),
        root: string(local.installLocation) || undefined,
        raw: [record, local, config.revision],
        actions: ['marketplace-remove', 'marketplace-refresh'],
      });
    }
  for (const [name, value] of Object.entries(known.data))
    if (!marketplaces.some((m) => m.name === name)) {
      const record = object(value);
      marketplaces.push({
        name,
        scope: 'unknown',
        source: sourceLabel(record.source),
        root: string(record.installLocation) || undefined,
        raw: record,
        actions: [],
      });
    }
  const plugins: PluginRecord[] = (await claudePluginRecords(c, jsonResult(result.stdout))).map((record) => {
    const selector = string(record.id),
      scope = string(record.scope),
      root = string(record.installPath);
    const writable =
      safeSelector(selector) && ['user', 'project', 'local'].includes(scope) && !!(scope === 'user' || c.project);
    return {
      selector,
      name: selector.split('@')[0]!,
      marketplace: selector.split('@')[1],
      scope,
      root,
      source: selector.split('@')[1] ?? '原生来源',
      version: typeof record.version === 'string' ? record.version : null,
      enabled: typeof record.enabled === 'boolean' ? record.enabled : null,
      raw: record,
      actions: writable
        ? [
            'enable',
            'disable',
            'uninstall',
            'update',
            'validate',
            ...(record.hasUserConfig ? ['configure' as const] : []),
          ]
        : [],
      reason: writable ? undefined : '托管或未知来源请从原生入口管理。',
    };
  });
  return { plugins, marketplaces, revisions: [...configs.map((s) => s.revision), known.revision], warnings: [] };
}
