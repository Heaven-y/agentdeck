import path from 'node:path';
import { arrayResult, jsonResult, safeName } from '../../../native-management/plugins/plugin-utils';
import {
  string,
  type PluginContext,
  type PluginInventory,
  type PluginRecord,
} from '../../../native-management/plugins/plugin-types';
import { NativeManagementError } from '../../../native-management/errors';
import { resourcePathKey } from '../../common/configuration/resources';
export async function antigravityPlugins(c: PluginContext): Promise<PluginInventory> {
  const result = await c.run(['plugin', 'list', '--json']);
  if (result.exitCode !== 0) throw new NativeManagementError('native_unavailable');
  const base = path.resolve(c.env.ANTIGRAVITY_GEMINI_DIR || path.join(c.homeDir, '.gemini'), 'config/plugins');
  const plugins: PluginRecord[] = arrayResult(jsonResult(result.stdout)).map((record) => {
    const name = string(record.name),
      root = string(record.path),
      writable = safeName(name) && resourcePathKey(path.dirname(root)) === resourcePathKey(base);
    return {
      selector: name,
      name,
      root,
      scope: writable
        ? 'user'
        : c.project &&
            path.isAbsolute(root) &&
            resourcePathKey(path.dirname(root)) === resourcePathKey(path.join(c.project.dir, '.agents/plugins'))
          ? 'project'
          : 'external',
      source: string(record.source) || '原生来源',
      version: typeof record.version === 'string' ? record.version : null,
      enabled: typeof record.enabled === 'boolean' ? record.enabled : null,
      raw: record,
      components: ['skills', 'agents', 'rules', 'mcpServers', 'hooks'].flatMap((key) =>
        Array.isArray(record[key])
          ? (record[key] as unknown[]).filter((v) => typeof v === 'string').map((v) => `${key}: ${v}`)
          : [],
      ),
      actions: writable ? ['enable', 'disable', 'uninstall', 'validate'] : [],
    };
  });
  return {
    plugins,
    marketplaces: [],
    revisions: [],
    warnings: [],
  };
}
