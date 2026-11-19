import type { NativeMcpConfigInput, NativeMcpEntry } from '@agentdeck/shared/settings';
import { NativeResourceError } from '../../agents/common/configuration/errors';
import { NativeManagementError } from '../errors';
import { isConfigObject, object, type McpAdapter, type McpSource } from './mcp-types';

type Config = Record<string, unknown>;
const urlField = (adapter: McpAdapter, config: Config) =>
  adapter.urlFields.find((key) => Object.hasOwn(config, key)) ?? adapter.urlFields[0];
export function sourceTransports(adapter: McpAdapter, source: McpSource): readonly NativeMcpConfigInput['transport'][] {
  return source.commandScope ? ['stdio'] : adapter.transports;
}
const nonemptyString = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const validCommand = (value: unknown) => nonemptyString(value) && !/[\r\n\0]/.test(value);

function inferredTransport(adapter: McpAdapter, config: Config): 'stdio' | 'http' | undefined {
  const address = config[urlField(adapter, config)];
  if (Object.hasOwn(config, 'command'))
    return validCommand(config.command) && address === undefined ? 'stdio' : undefined;
  return nonemptyString(address) ? 'http' : undefined;
}
function nativeTransportTag(adapter: McpAdapter, config: Config, fallback: 'stdio' | 'http'): unknown {
  if (adapter.transportTag && Object.hasOwn(config, 'type')) return config.type;
  return adapter.transportTag === 'explicit' ? 'stdio' : fallback;
}
export function mcpTransport(adapter: McpAdapter, config: Config): NativeMcpEntry['transport'] {
  const inferred = inferredTransport(adapter, config);
  if (!inferred) return 'unknown';
  const tag = nativeTransportTag(adapter, config, inferred);
  const type = inferred === 'http' && tag === 'sse' ? 'sse' : inferred;
  if (tag !== type || !adapter.transports.includes(type) || adapter.acceptsTransport?.(config, type) === false)
    return 'unknown';
  return type;
}
export function configuredEnabled({ enabledField }: McpAdapter, config: Config): boolean | null {
  if (!enabledField) return null;
  const value = config[enabledField];
  if (value === undefined) return true;
  return typeof value === 'boolean' ? value === (enabledField === 'enabled') : null;
}
export function setConfiguredEnabled({ enabledField }: McpAdapter, config: Config, enabled: boolean) {
  if (!enabledField) throw new NativeManagementError('unsupported_action');
  return { ...config, [enabledField]: enabledField === 'enabled' ? enabled : !enabled };
}
export function publicMcpConfig(adapter: McpAdapter, value: Config): NativeMcpEntry['config'] {
  const address = value[urlField(adapter, value)];
  const bearer = adapter.bearerField && value[adapter.bearerField];
  let urlOrigin: string | undefined;
  try {
    if (typeof address === 'string') {
      const url = new URL(address);
      if (['http:', 'https:'].includes(url.protocol)) urlOrigin = url.origin;
    }
  } catch {
    /* 不暴露无法解析的原始地址。 */
  }
  return {
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
    argsConfigured: Array.isArray(value.args) && value.args.length > 0,
    urlConfigured: typeof address === 'string',
    urlOrigin,
    envKeys: Object.keys(object(value.env)),
    headerKeys: Object.keys(object(value[adapter.headerField])),
    ...(typeof bearer === 'string' ? { bearerTokenEnvVar: bearer } : {}),
  };
}
function applySecrets(target: Record<string, unknown>, key: string, input: NonNullable<NativeMcpConfigInput['env']>) {
  const previous = target[key];
  if (previous !== undefined && !isConfigObject(previous)) throw new NativeResourceError('invalid_request');
  if (Object.values(input).every((edit) => edit.action === 'keep')) return;
  const values = { ...previous };
  for (const [name, edit] of Object.entries(input)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new NativeResourceError('invalid_request');
    if (edit.action === 'clear') delete values[name];
    else if (edit.action === 'replace') values[name] = edit.value;
  }
  if (Object.keys(values).length) target[key] = values;
  else delete target[key];
}
export function mergeMcpConfig(adapter: McpAdapter, source: McpSource, before: Config, input: NativeMcpConfigInput) {
  if (!sourceTransports(adapter, source).includes(input.transport))
    throw new NativeManagementError('unsupported_action');
  const value = structuredClone(before);
  if (adapter.transportTag === 'explicit') value.type = input.transport;
  if (input.transport === 'stdio') applyStdio(adapter, value, input);
  else applyRemote(adapter, value, input);
  if (input.env) applySecrets(value, 'env', input.env);
  if (input.headers) applySecrets(value, adapter.headerField, input.headers);
  applyBearer(adapter, value, input.bearerTokenEnvVar);
  if (mcpTransport(adapter, value) !== input.transport) throw new NativeManagementError('unsupported_action');
  return value;
}
function applyStdio(adapter: McpAdapter, value: Record<string, unknown>, input: NativeMcpConfigInput) {
  for (const field of adapter.urlFields) delete value[field];
  if (input.command !== undefined) value.command = input.command;
  if (input.args !== undefined) value.args = input.args;
  if (!validCommand(value.command)) throw new NativeResourceError('invalid_request');
}
function applyRemote(adapter: McpAdapter, value: Record<string, unknown>, input: NativeMcpConfigInput) {
  delete value.command;
  delete value.args;
  const key = urlField(adapter, value);
  if (input.url?.action === 'clear') throw new NativeResourceError('invalid_request');
  // 保留已有原生值，不解析 CLI 的环境变量占位符；只有新地址走表单校验。
  if (input.url?.action === 'replace') {
    checkHttpUrl(input.url.value);
    value[key] = input.url.value;
  }
  if (!nonemptyString(value[key])) throw new NativeResourceError('invalid_request');
}
function checkHttpUrl(address: string) {
  try {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new NativeResourceError('invalid_request');
  }
}
function applyBearer(
  { bearerField }: McpAdapter,
  value: Record<string, unknown>,
  bearer: NativeMcpConfigInput['bearerTokenEnvVar'],
) {
  if (bearer !== undefined) {
    if (!bearerField) throw new NativeManagementError('unsupported_action');
    if (bearer === null) delete value[bearerField];
    else value[bearerField] = bearer;
  }
}
