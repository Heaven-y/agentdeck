import type { NativePluginCatalog, NativePluginOperation } from '@agentdeck/shared/settings';
import { resourcePathKey } from '../agents/common/configuration/resources';
import { claudePlugins } from '../agents/claude/configuration/plugins';
import { codexPlugins } from '../agents/codex/configuration/plugins';
import { antigravityPlugins } from '../agents/antigravity/configuration/plugins';
import { enrichPlugin } from './plugin-native';
import { pluginDigest } from './plugin-utils';
import type { PluginContext, PluginRecord, PluginMarketplace } from './plugin-types';
const versions = { claude: '2.1.317', codex: '0.166.0', antigravity: '1.5.3' };
const adapters = { claude: claudePlugins, codex: codexPlugins, antigravity: antigravityPlugins };
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
    reason: supported ? p.reason : '当前 CLI 版本未核实，仅展示原生状态。',
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
  const native = await adapters[c.agent](c),
    result = await c.run(['--version']);
  const supported =
    result.exitCode === 0 && result.stdout.toString().match(/\b\d+\.\d+\.\d+\b/)?.[0] === versions[c.agent];
  for (const p of native.plugins) {
    await enrichPlugin(p, c.agent);
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
    installScopes: [],
    canAddMarketplace: supported,
    warnings: [...native.warnings, ...(!supported ? ['当前 CLI 版本未核实，操作已停用。'] : [])],
  };
  if (c.agent === 'antigravity') catalog.canAddMarketplace = false;
  catalog.installScopes = installScopes(c, supported);
  return { native, catalog };
}

function installScopes(c: PluginContext, supported: boolean): NativePluginCatalog['installScopes'] {
  if (!supported) return [];
  return c.agent === 'claude' && c.project ? ['user', 'project', 'local'] : ['user'];
}
