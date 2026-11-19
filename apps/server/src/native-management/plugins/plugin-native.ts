import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import type { NativePluginPrepareInput, NativePluginOption } from '@agentdeck/shared/settings';
import { nativeFileTransaction } from '../../platform/files/transactions';
import { inspectDirectory, readConfigFile, writeConfigFile } from '../../platform/files/safe-file';
import { NativeResourceError } from '../../agents/common/configuration/errors';
import { readNativeConfigSource } from '../config';
import { NativeManagementError } from '../errors';
import { editMcpToml } from '../mcp/mcp-toml';
import { object, string, type PluginContext, type PluginRecord, type PluginMarketplace } from './plugin-types';
import { jsonResult, safeName, validatePluginSource } from './plugin-utils';
import { pluginAdapter } from './plugin-adapters';

export async function enrichPlugin(plugin: PluginRecord, files: readonly string[]) {
  if (!plugin.root || !path.isAbsolute(plugin.root)) return;
  for (const file of files) {
    const manifest = await readNativeConfigSource(path.join(plugin.root, file), 'managed');
    if (manifest.revision === 'missing') continue;
    plugin.raw = [plugin.raw, manifest.revision];
    plugin.description = string(manifest.data.description).slice(0, 4096);
    break;
  }
}
const configurationKey = randomBytes(32);
export async function pluginConfiguration(c: PluginContext, plugin: PluginRecord) {
  if (c.agent !== 'claude' || !plugin.actions.includes('configure'))
    throw new NativeManagementError('unsupported_action');
  const result = await c.run(['plugin', 'configure', plugin.selector, '--json']);
  if (result.exitCode !== 0) throw new NativeManagementError('native_unavailable');
  const value = object(jsonResult(result.stdout)),
    schema = object(value.schema),
    configured = Array.isArray(value.configured) ? value.configured : [];
  if (Object.keys(schema).length > 64) throw new NativeManagementError('native_unavailable');
  const configurationRevision = createHmac('sha256', configurationKey)
    .update(JSON.stringify([plugin.selector, value]))
    .digest('hex');
  const options: NativePluginOption[] = Object.entries(schema).map(([key, raw]) => {
    const option = object(raw);
    if (!safeName(key)) throw new NativeManagementError('native_unavailable');
    return {
      key,
      title: string(option.title) || key,
      description: string(option.description).slice(0, 2048),
      sensitive: option.sensitive === true,
      required: option.required === true,
      configured: configured.includes(key),
      ...(Array.isArray(object(value.choices)[key])
        ? {
            choices: (object(value.choices)[key] as unknown[])
              .filter((v): v is string => typeof v === 'string')
              .slice(0, 100),
          }
        : {}),
    };
  });
  return { options, configurationRevision };
}
export async function pluginOptions(c: PluginContext, plugin: PluginRecord) {
  return (await pluginConfiguration(c, plugin)).options;
}
async function validateNewSource(c: PluginContext, input: NativePluginPrepareInput) {
  if (!input.source || input.id) throw new NativeResourceError('invalid_request');
  const adapter = pluginAdapter(c.agent);
  const scope = input.scope ?? 'user';
  if (!adapter.verbs[input.action] || !adapter.installScopes.includes(scope))
    throw new NativeManagementError('unsupported_action');
  if (scope !== 'user' && !c.project) throw new NativeResourceError('project_missing');
  await validatePluginSource(input.source, input.action === 'install' && adapter.installSelector);
}
function validateSelected(input: NativePluginPrepareInput, plugin?: PluginRecord, market?: PluginMarketplace) {
  if (input.source !== undefined || input.scope !== undefined) throw new NativeResourceError('invalid_request');
  if (input.action.startsWith('marketplace-')) {
    if (!market || !market.actions.includes(input.action) || !safeName(market.name))
      throw new NativeManagementError('unsupported_action');
  } else if (!plugin || !plugin.actions.includes(input.action)) throw new NativeManagementError('unsupported_action');
}
export async function validatePreparation(
  c: PluginContext,
  input: NativePluginPrepareInput,
  plugin?: PluginRecord,
  market?: PluginMarketplace,
) {
  if (input.action === 'install' || input.action === 'marketplace-add') await validateNewSource(c, input);
  else validateSelected(input, plugin, market);
  if (input.action === 'validate') await validateRoot(plugin);
  if (input.action !== 'configure') {
    if (input.values !== undefined || input.configurationRevision !== undefined)
      throw new NativeResourceError('invalid_request');
    return;
  }
  await validateConfiguration(c, input, plugin!);
}
async function validateConfiguration(c: PluginContext, input: NativePluginPrepareInput, plugin: PluginRecord) {
  const snapshot = await pluginConfiguration(c, plugin);
  if (input.configurationRevision !== snapshot.configurationRevision)
    throw new NativeResourceError('revision_conflict');
  const fields = snapshot.options,
    values = input.values ?? {};
  if (Object.keys(values).length === 0 || Object.keys(values).some((key) => !fields.some((f) => f.key === key)))
    throw new NativeResourceError('invalid_request');
}
export async function writeCodexEnabled(plugin: PluginRecord, enabled: boolean) {
  const source = plugin.config;
  if (!source) throw new NativeManagementError('unsupported_action');
  await nativeFileTransaction(source.file, async () => {
    const parents = await inspectDirectory(path.dirname(source.file), true);
    const previous = await readConfigFile(source.file);
    if (previous.revision !== source.revision) throw new NativeResourceError('revision_conflict');
    const content = editMcpToml(source.content, ['plugins', plugin.selector, 'enabled'], enabled);
    await writeConfigFile(source.file, Buffer.from(content), previous, parents!);
  });
}
type CommandTarget = { plugin?: PluginRecord; market?: PluginMarketplace; confirmation?: string };
function marketplaceArguments(
  agent: PluginContext['agent'],
  input: NativePluginPrepareInput,
  target: CommandTarget,
  verb: string,
) {
  const scope = target.market?.scope ?? input.scope ?? 'user';
  return [
    'plugin',
    'marketplace',
    verb,
    target.market?.name ?? input.source!,
    ...(agent === 'claude' && input.action !== 'marketplace-refresh' ? ['--scope', scope] : []),
    '--json',
  ];
}
export function pluginArguments(c: PluginContext, input: NativePluginPrepareInput, options: CommandTarget = {}) {
  const { action } = input;
  const verb = pluginAdapter(c.agent).verbs[action];
  if (!verb) throw new NativeManagementError('unsupported_action');
  const target = options.plugin?.selector ?? input.source!;
  if (action.startsWith('marketplace-')) return marketplaceArguments(c.agent, input, options, verb);
  if (action === 'validate') return ['plugin', verb, options.plugin!.root!, '--json'];
  if (action === 'configure') return ['plugin', verb, target, '--json', '--values-stdin'];
  const args = ['plugin', verb, target];
  if (c.agent === 'claude') return claudeArguments(args, input, options);
  return c.agent === 'codex' ? [...args, '--json'] : args;
}
function claudeArguments(args: string[], input: NativePluginPrepareInput, options: CommandTarget) {
  return [
    ...args,
    '--scope',
    options.plugin?.scope ?? input.scope ?? 'user',
    ...(input.action === 'uninstall' ? ['--keep-data'] : []),
    '--json',
    ...(options.confirmation ? ['--accept-command', options.confirmation] : []),
  ];
}
export function nativeConfirmation(stdout: Buffer) {
  let result: Record<string, unknown>;
  try {
    result = object(jsonResult(stdout));
  } catch {
    return undefined;
  }
  const command = object(result.shownCommand);
  if (
    typeof command.command === 'string' &&
    command.command.length <= 4096 &&
    typeof command.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(command.sha256)
  )
    return { command: command.command, sha256: command.sha256 };
  return undefined;
}

async function validateRoot(plugin: PluginRecord | undefined) {
  if (!plugin?.root || !(await inspectDirectory(plugin.root))) throw new NativeManagementError('unsupported_action');
}
