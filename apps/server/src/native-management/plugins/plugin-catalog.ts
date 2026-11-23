import type { NativePluginAction, NativePluginCatalog, NativePluginOperation } from '@agentdeck/shared/settings';
import { resourcePathKey } from '../../agents/common/configuration/resources';
import { pluginAdapter } from './plugin-adapters';
import { enrichPlugin } from './plugin-native';
import { pluginDigest } from './plugin-utils';
import type { PluginContext, PluginRecord, PluginMarketplace } from './plugin-types';

async function supportedCommands(c: PluginContext, command: string[]) {
  const result = await c.run([...command, '--help']).catch(() => undefined);
  // AGY 的帮助走 stderr，Claude 和 Codex 走 stdout；只有成功的帮助输出才用于判断。
  const lines =
    result?.exitCode === 0 ? `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`.split(/\r?\n/) : [];
  const start = lines.findIndex((line) => line.trim() === 'Commands:');
  const names = new Set<string>();
  if (start < 0) return names;
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith(' ')) break;
    const name = /^ {2}([a-z][a-z-]*)(?=[\s|]|$)/.exec(line)?.[1];
    if (name) names.add(name);
  }
  return names;
}

async function pluginActions(c: PluginContext, adapter: ReturnType<typeof pluginAdapter>) {
  const commands = await supportedCommands(c, ['plugin']);
  const marketCommands = commands.has('marketplace')
    ? await supportedCommands(c, ['plugin', 'marketplace'])
    : new Set<string>();
  return new Set(
    (Object.entries(adapter.verbs) as [NativePluginAction, string][])
      .filter(([action, verb]) => (action.startsWith('marketplace-') ? marketCommands : commands).has(verb))
      .map(([action]) => action),
  );
}

function publicPlugin(c: PluginContext, p: PluginRecord, revisions: unknown[], actions: Set<NativePluginAction>) {
  p.actions = p.actions.filter(
    (action) => actions.has(action) || (c.agent === 'codex' && (action === 'enable' || action === 'disable')),
  );
  const id = pluginDigest([c.agent, p.selector, p.scope, p.root ? resourcePathKey(p.root) : '', p.config?.file]);
  p.entry = {
    id,
    revision: pluginDigest([id, p.raw, revisions, p.actions]),
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
    reason: p.reason,
  };
}
function publicMarket(c: PluginContext, m: PluginMarketplace, actions: Set<NativePluginAction>) {
  m.actions = m.actions.filter((action) => actions.has(action));
  const id = pluginDigest([c.agent, m.name, m.scope, m.root ? resourcePathKey(m.root) : '', m.source]);
  m.entry = {
    id,
    revision: pluginDigest([id, m.raw, m.actions]),
    name: m.name,
    scope: m.scope,
    source: m.source,
    actions: m.actions,
  };
}
export async function readPluginInventory(c: PluginContext, operations: NativePluginOperation[] = []) {
  const adapter = pluginAdapter(c.agent);
  const [native, actions] = await Promise.all([adapter.read(c), pluginActions(c, adapter)]);
  for (const p of native.plugins) {
    await enrichPlugin(p, adapter.manifestFiles);
    publicPlugin(c, p, native.revisions, actions);
  }
  for (const m of native.marketplaces) publicMarket(c, m, actions);
  const catalog: NativePluginCatalog = {
    agent: c.agent,
    revision: pluginDigest([
      native.plugins.map((p) => p.entry!.revision).sort(),
      native.marketplaces.map((m) => m.entry!.revision).sort(),
      native.revisions,
      [...actions].sort(),
    ]),
    entries: native.plugins.map((p) => p.entry!),
    marketplaces: native.marketplaces.map((m) => m.entry!),
    operations,
    installScopes:
      actions.has('install') || actions.has('marketplace-add')
        ? adapter.installScopes.filter((scope) => c.project || scope === 'user')
        : [],
    canInstall: actions.has('install'),
    canAddMarketplace: actions.has('marketplace-add'),
    warnings: native.warnings,
  };
  return { native, catalog };
}
