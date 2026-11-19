import path from 'node:path';
import { readNativeConfigSource } from '../../../native-management/config';
import { directories, safeSelector, sourceLabel, pluginDigest } from '../../../native-management/plugins/plugin-utils';
import { resourcePathKey } from '../../common/configuration/resources';
import type { PluginPolicy } from '../../../native-management/plugins/plugin-policy';
import type { NativeConfigSource } from '../../../native-management/config';
import {
  object,
  string,
  type PluginContext,
  type PluginInventory,
  type PluginMarketplace,
  type PluginRecord,
} from '../../../native-management/plugins/plugin-types';
const managedKinds = [
  'mdm',
  'system',
  'enterpriseManaged',
  'legacyManagedConfigTomlFromFile',
  'legacyManagedConfigTomlFromMdm',
];
const managed = (policy: PluginPolicy, key: 'plugins' | 'marketplaces', name: string) =>
  policy.layers.some(
    (layer) => !layer.disabled && managedKinds.includes(layer.kind) && Object.hasOwn(layer[key], name),
  );
async function readPolicy(c: PluginContext): Promise<PluginPolicy> {
  try {
    return (await c.readPolicy?.()) ?? { verified: false, enabled: {}, layers: [] };
  } catch {
    return { verified: false, enabled: {}, layers: [] };
  }
}
async function sources(c: PluginContext, base: string, policy: PluginPolicy) {
  const configs = [await readNativeConfigSource(path.join(base, 'config.toml'), 'user')];
  if (c.project) configs.push(await readNativeConfigSource(path.join(c.project.dir, '.codex/config.toml'), 'project'));
  for (const layer of policy.layers) {
    if (
      layer.file &&
      layer.kind === 'project' &&
      !configs.some((s) => resourcePathKey(s.file) === resourcePathKey(layer.file!))
    )
      configs.push(await readNativeConfigSource(layer.file, 'project'));
    if (managedKinds.includes(layer.kind) && !layer.disabled)
      configs.push({
        file: layer.file ?? `managed:${layer.kind}`,
        scope: 'managed',
        content: '',
        revision: pluginDigest([layer.kind, layer.version, layer.plugins, layer.marketplaces]),
        data: { plugins: layer.plugins, marketplaces: layer.marketplaces },
      });
  }
  return configs;
}
function marketplace(
  config: NativeConfigSource,
  policy: PluginPolicy,
  name: string,
  value: unknown,
): PluginMarketplace {
  const record = object(value);
  return {
    name,
    scope: config.scope,
    source: sourceLabel(record),
    root: record.source_type === 'local' ? string(record.source) : undefined,
    raw: [record, config.revision],
    actions:
      policy.verified && !managed(policy, 'marketplaces', name) && config.scope === 'user'
        ? ['marketplace-remove', ...(record.source_type === 'git' ? ['marketplace-refresh' as const] : [])]
        : [],
  };
}
async function installation(base: string, selector: string) {
  const [name, market] = selector.split('@');
  const roots = safeSelector(selector) ? await directories(path.join(base, 'plugins/cache', market!, name!)) : [];
  const root = roots.length === 1 ? path.join(base, 'plugins/cache', market!, name!, roots[0]!) : undefined;
  const manifest = root
    ? await readNativeConfigSource(path.join(root, '.codex-plugin/plugin.json'), 'managed')
    : undefined;
  return { roots, root, manifest };
}
function writable(policy: PluginPolicy, config: NativeConfigSource, selector: string, root: string | undefined) {
  if (
    !safeSelector(selector) ||
    !root ||
    !policy.verified ||
    config.scope === 'managed' ||
    managed(policy, 'plugins', selector)
  )
    return false;
  const layer = policy.layers.find(
    (layer) => layer.file && resourcePathKey(layer.file) === resourcePathKey(config.file),
  );
  return !layer?.disabled;
}
async function plugin(
  base: string,
  policy: PluginPolicy,
  config: NativeConfigSource,
  item: [string, unknown],
): Promise<PluginRecord> {
  const [selector, value] = item,
    record = object(value),
    [name, marketplace] = selector.split('@');
  const installed = await installation(base, selector);
  const allowed = writable(policy, config, selector, installed.root);
  return {
    selector,
    name: name!,
    marketplace,
    scope: config.scope,
    root: installed.root,
    source: marketplace ?? '原生配置',
    version:
      installed.manifest && typeof installed.manifest.data.version === 'string'
        ? installed.manifest.data.version
        : null,
    enabled: typeof record.enabled === 'boolean' ? record.enabled : null,
    description: installed.manifest ? string(installed.manifest.data.description).slice(0, 4096) : '',
    config,
    raw: [record, config.revision, installed.roots, installed.manifest?.revision, policy],
    actions: allowed ? ['enable', 'disable', ...(config.scope === 'user' ? ['uninstall' as const] : [])] : [],
    reason: allowed ? undefined : '原生策略、信任或安装目录尚不能核实为可写；请使用原生入口检查。',
  };
}
export async function codexPlugins(c: PluginContext): Promise<PluginInventory> {
  const base = path.resolve(c.env.CODEX_HOME || path.join(c.homeDir, '.codex')),
    policy = await readPolicy(c),
    configs = await sources(c, base, policy);
  const marketplaces = configs.flatMap((config) =>
    Object.entries(object(config.data.marketplaces)).map(([name, value]) => marketplace(config, policy, name, value)),
  );
  const plugins: PluginRecord[] = [];
  for (const config of configs)
    for (const item of Object.entries(object(config.data.plugins)))
      plugins.push(await plugin(base, policy, config, item));
  return {
    plugins,
    marketplaces,
    revisions: [...configs.map((s) => s.revision), policy],
    warnings: [
      '离线读取原生配置及安装缓存；托管策略、信任与覆盖仍由原生决定。没有独立单插件更新命令，刷新市场不会表示插件已更新。',
    ],
  };
}
