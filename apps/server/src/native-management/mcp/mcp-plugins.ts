import path from 'node:path';
import { resolveLocalCommand } from '../../platform/process/executable';
import { runProcess } from '../../platform/process/run';
import { readNativeConfigSource } from '../config';
import { object, type McpContext, type McpPlugin } from './mcp-types';
import type { NativeResourceScope } from '@agentdeck/shared/settings';
import { NativeManagementError } from '../errors';
import { codexPlugins } from '../../agents/codex/configuration/plugins';
import { claudePluginRecords } from '../../agents/claude/configuration/plugin-records';
function relativePluginFile(root: string, file: string): string {
  const relative = file.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]/, '');
  const target = path.resolve(root, relative),
    rel = path.relative(root, target);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`))
    throw new NativeManagementError('native_unavailable');
  return target;
}
async function claudeManifestServers(root: string): Promise<Record<string, unknown>> {
  const manifest = await readNativeConfigSource(path.join(root, '.claude-plugin/plugin.json'), 'managed');
  const declaration = manifest.data.mcpServers;
  if (declaration === undefined) return {};
  if (declaration && typeof declaration === 'object' && !Array.isArray(declaration)) return object(declaration);
  const files = Array.isArray(declaration) ? declaration : [declaration];
  if (files.length > 16 || files.some((f) => typeof f !== 'string'))
    throw new NativeManagementError('native_unavailable');
  const servers: Record<string, unknown> = {};
  for (const file of files as string[]) {
    const config = await readNativeConfigSource(relativePluginFile(root, file), 'managed');
    Object.assign(servers, object(config.data.mcpServers ?? config.data));
  }
  return servers;
}
/** 只查询已安装插件目录；Codex plugin list 可能访问市场，因此不在离线 GET 使用。 */
export async function readMcpPlugins(context: McpContext): Promise<McpPlugin[]> {
  if (context.agent === 'codex') {
    const inventory = await codexPlugins({
      ...context,
      run: () => Promise.reject(new Error()),
    });
    return mcpPluginsFromRecords(
      context,
      inventory.plugins
        .filter((plugin) => plugin.root)
        .map((plugin) => ({
          id: plugin.selector,
          scope: plugin.scope,
          installPath: plugin.root,
        })),
    );
  }
  const cli = resolveLocalCommand(context.agent === 'claude' ? 'claude' : 'agy', context.env);
  const result = await runProcess(cli.command, [...cli.args, 'plugin', 'list', '--json'], {
    cwd: context.project?.dir ?? context.homeDir,
    env: context.env,
    timeoutMs: 15000,
    outputCap: 512 * 1024,
  });
  if (result.exitCode !== 0) throw new Error();
  const plugins: unknown = JSON.parse(result.stdout.toString('utf8'));
  return mcpPluginsFromRecords(
    context,
    context.agent === 'claude' ? await claudePluginRecords(context, plugins) : plugins,
  );
}
export async function mcpPluginsFromRecords(context: McpContext, plugins: unknown): Promise<McpPlugin[]> {
  if (!Array.isArray(plugins) || plugins.length > 512) throw new Error();
  const records: McpPlugin[] = [];
  for (const item of plugins) records.push(...(await pluginEntries(context, item)));
  return records;
}
async function pluginEntries(context: McpContext, item: unknown): Promise<McpPlugin[]> {
  const plugin = object(item),
    root = plugin.installPath ?? plugin.path,
    owner = plugin.id ?? plugin.name;
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof owner !== 'string') return [];
  const file = path.join(root, context.agent === 'antigravity' ? 'mcp_config.json' : '.mcp.json');
  const config = await readNativeConfigSource(file, 'managed');
  const servers = object(config.data.mcpServers ?? config.data);
  if (context.agent === 'claude') Object.assign(servers, await claudeManifestServers(root));
  addNames(servers, plugin.mcpServers);
  const scope = scopeOf(plugin.scope);
  const nativeScope = typeof plugin.scope === 'string' ? plugin.scope : undefined;
  return Object.entries(servers).map(([name, value]) => ({
    name,
    owner,
    installationRoot: root,
    nativeScope,
    scope,
    config: object(value),
  }));
}
function addNames(servers: Record<string, unknown>, names: unknown) {
  if (!Array.isArray(names)) return;
  for (const name of names)
    if (typeof name === 'string' && !Object.hasOwn(servers, name))
      Object.defineProperty(servers, name, { value: {}, enumerable: true });
}
function scopeOf(scope: unknown): NativeResourceScope {
  return typeof scope === 'string' && ['user', 'project', 'local', 'managed', 'directory'].includes(scope)
    ? (scope as NativeResourceScope)
    : 'directory';
}
