import type { NativePluginCatalog, NativePluginPrepareInput } from '@agentdeck/shared/settings';
import type { PluginContext, PluginRecord, PluginMarketplace } from './plugin-types';
import { pluginOptions } from './plugin-native';
type Target = { input: NativePluginPrepareInput; plugin?: PluginRecord; market?: PluginMarketplace; scope: string };
function verifyMarket(target: Target, after: NativePluginCatalog, before: NativePluginCatalog) {
  switch (target.input.action) {
    case 'marketplace-remove':
      return !after.marketplaces.some((m) => m.name === target.market?.name && m.scope === target.scope);
    case 'marketplace-add':
      return after.marketplaces.some((m) => !before.marketplaces.some((p) => p.id === m.id));
    case 'marketplace-refresh':
      return after.marketplaces.some((m) => m.name === target.market?.name);
    default:
      return false;
  }
}
export async function verifyPluginResult(
  c: PluginContext,
  target: Target,
  after: NativePluginCatalog,
  before: NativePluginCatalog,
) {
  const { input, plugin, scope } = target;
  const found = after.entries.find((e) => e.selector === (plugin?.selector ?? input.source) && e.scope === scope);
  if (input.action.startsWith('marketplace-')) return verifyMarket(target, after, before);
  if (input.action === 'configure') {
    const options = await pluginOptions(c, plugin!);
    return Object.keys(input.values ?? {}).every((key) => options.some((o) => o.key === key && o.configured));
  }
  return verifyEntry(c.agent, input.action, found, { after, before });
}
function verifyEntry(
  agent: PluginContext['agent'],
  action: NativePluginPrepareInput['action'],
  found: NativePluginCatalog['entries'][number] | undefined,
  catalogs: { after: NativePluginCatalog; before: NativePluginCatalog },
) {
  switch (action) {
    case 'uninstall':
      return !found;
    case 'enable':
      return found?.enabled === true;
    case 'disable':
      return found?.enabled === false;
    case 'update':
      return found?.version != null;
    case 'install':
      return installationConfirmed(agent, found, catalogs);
    default:
      return action === 'validate';
  }
}

function installationConfirmed(
  agent: PluginContext['agent'],
  found: NativePluginCatalog['entries'][number] | undefined,
  catalogs: { after: NativePluginCatalog; before: NativePluginCatalog },
) {
  return (
    !!found ||
    (agent === 'antigravity' && catalogs.after.entries.some((e) => !catalogs.before.entries.some((p) => p.id === e.id)))
  );
}
