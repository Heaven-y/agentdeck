import type { NativePluginCatalog, NativePluginOperation } from '@agentdeck/shared/settings';
import { resourcePathKey } from '../../agents/common/configuration/resources';
import { pluginAdapter } from './plugin-adapters';
import { enrichPlugin } from './plugin-native';
import { pluginDigest } from './plugin-utils';
import type { PluginContext, PluginRecord, PluginMarketplace } from './plugin-types';

function publicPlugin(c: PluginContext, p: PluginRecord, revisions: unknown[], supported: boolean) {
  if (!supported) p.actions = [];
  const id = pluginDigest([c.agent, p.selector, p.scope, p.root ? resourcePathKey(p.root) : '', p.config?.file]);
  p.entry = {
    id,
    revision: pluginDigest([id, p.raw, revisions, supported]),
    selector: p.selector,
    name: p.name,
    source: p.source,
    scope: p.scope,
    marketplace: p.marketplace,
    version: p.version,
    enabled: p.enabled,
    description: p.description ?? '',
    components: p.components ?? [],
    actions: p.actions,
    reason: supported ? p.reason : undefined,
  };
}
function publicMarket(c: PluginContext, m: PluginMarketplace, supported: boolean) {
  if (!supported) m.actions = [];
  const id = pluginDigest([c.agent, m.name, m.scope, m.root ? resourcePathKey(m.root) : '', m.source]);
  m.entry = {
    id,
    revision: pluginDigest([id, m.raw, supported]),
    name: m.name,
    scope: m.scope,
    source: m.source,
    actions: m.actions,
  };
}
export async function readPluginInventory(c: PluginContext, operations: NativePluginOperation[] = []) {
  const adapter = pluginAdapter(c.agent);
  const native = await adapter.read(c);
  const result = await c.run(['--version']);
  const version = result.stdout.toString().match(/\b\d+\.\d+\.\d+[\w.+-]*/)?.[0];
  const supported = result.exitCode === 0 && version === adapter.version;
  for (const p of native.plugins) {
    await enrichPlugin(p, adapter.manifestFiles);
    publicPlugin(c, p, native.revisions, supported);
  }
  for (const m of native.marketplaces) publicMarket(c, m, supported);
  const catalog: NativePluginCatalog = {
    agent: c.agent,
    revision: pluginDigest([
      native.plugins.map((p) => p.entry!.revision).sort(),
      native.marketplaces.map((m) => m.entry!.revision).sort(),
      native.revisions,
      supported,
    ]),
    entries: native.plugins.map((p) => p.entry!),
    marketplaces: native.marketplaces.map((m) => m.entry!),
    operations,
    installScopes:
      supported && adapter.verbs.install ? adapter.installScopes.filter((scope) => c.project || scope === 'user') : [],
    canAddMarketplace: supported && !!adapter.verbs['marketplace-add'],
    warnings: [...native.warnings, ...(!supported ? ['当前版本暂不能在此管理插件，请在 CLI 中操作。'] : [])],
  };
  return { native, catalog };
}
