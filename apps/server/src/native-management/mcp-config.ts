import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativeMcpConfigInput, NativeMcpEntry } from '@agentdeck/shared/settings';
import { NativeResourceError } from '../agents/common/configuration/errors';
import { NativeManagementError } from './errors';
import { object } from './mcp-types';
import { isDeepStrictEqual } from 'node:util';

export function mcpTransport(agent: AgentKind, config: Record<string, unknown>): NativeMcpEntry['transport'] {
  if (config.type !== undefined && config.type !== 'stdio' && config.type !== 'http' && config.type !== 'sse')
    return 'unknown';
  if (typeof config.command === 'string') return 'stdio';
  if (config.type === 'sse') return agent === 'claude' ? 'sse' : 'unknown';
  if (typeof config.url === 'string' || typeof config.serverUrl === 'string') return 'http';
  return 'unknown';
}
const urlField = (agent: AgentKind, config: Record<string, unknown>) =>
  agent === 'antigravity' && !Object.hasOwn(config, 'url') ? 'serverUrl' : 'url';
export function publicMcpConfig(agent: AgentKind, value: Record<string, unknown>): NativeMcpEntry['config'] {
  let urlOrigin: string | undefined;
  try {
    const url = new URL(String(value[urlField(agent, value)]));
    if (['http:', 'https:'].includes(url.protocol)) urlOrigin = url.origin;
  } catch {
    /* 不暴露无法解析的原始地址。 */
  }
  return {
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
    argsConfigured: Array.isArray(value.args) && value.args.length > 0,
    urlConfigured: typeof value[urlField(agent, value)] === 'string',
    urlOrigin,
    envKeys: Object.keys(object(value.env)),
    headerKeys: Object.keys(object(value[agent === 'codex' ? 'http_headers' : 'headers'])),
    ...(typeof value.bearer_token_env_var === 'string' ? { bearerTokenEnvVar: value.bearer_token_env_var } : {}),
  };
}
function applySecrets(target: Record<string, unknown>, key: string, input: NonNullable<NativeMcpConfigInput['env']>) {
  if (target[key] !== undefined && (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])))
    throw new NativeResourceError('invalid_request');
  const values = { ...object(target[key]) };
  for (const [name, edit] of Object.entries(input)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new NativeResourceError('invalid_request');
    if (edit.action === 'clear') delete values[name];
    else if (edit.action === 'replace') values[name] = edit.value;
  }
  target[key] = values;
}
export function mergeMcpConfig(agent: AgentKind, before: Record<string, unknown>, input: NativeMcpConfigInput) {
  if (input.transport === 'sse' && agent !== 'claude') throw new NativeManagementError('unsupported_action');
  const value = structuredClone(before);
  if (agent === 'claude') value.type = input.transport;
  if (input.transport === 'stdio') applyStdio(value, input);
  else applyRemote(agent, value, input);
  if (input.env) applySecrets(value, 'env', input.env);
  if (input.headers) applySecrets(value, agent === 'codex' ? 'http_headers' : 'headers', input.headers);
  applyBearer(agent, value, input.bearerTokenEnvVar);
  return value;
}
function applyStdio(value: Record<string, unknown>, input: NativeMcpConfigInput) {
  delete value.url;
  delete value.serverUrl;
  if (input.command !== undefined) value.command = input.command;
  if (input.args !== undefined) value.args = input.args;
  if (typeof value.command !== 'string' || !value.command.trim() || /[\r\n\0]/.test(value.command))
    throw new NativeResourceError('invalid_request');
}
function applyRemote(agent: AgentKind, value: Record<string, unknown>, input: NativeMcpConfigInput) {
  delete value.command;
  delete value.args;
  const key = urlField(agent, value);
  if (input.url?.action === 'replace') value[key] = input.url.value;
  if (input.url?.action === 'clear') delete value[key];
  try {
    const url = new URL(String(value[key]));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new NativeResourceError('invalid_request');
  }
}
function applyBearer(
  agent: AgentKind,
  value: Record<string, unknown>,
  bearer: NativeMcpConfigInput['bearerTokenEnvVar'],
) {
  if (bearer !== undefined) {
    if (agent !== 'codex') throw new NativeManagementError('unsupported_action');
    if (bearer === null) delete value.bearer_token_env_var;
    else value.bearer_token_env_var = bearer;
  }
}
/** CLI add-json 没有配置 stdin：任何可携带秘密的值均不放入进程参数。 */
export function safeClaudeArguments(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).every((key) => ['type', 'command', 'args', 'env', 'headers'].includes(key)) &&
    (!Array.isArray(value.args) || value.args.length === 0) &&
    Object.keys(object(value.env)).length === 0 &&
    Object.keys(object(value.headers)).length === 0
  );
}
function normalizedClaudeEntry(value: unknown) {
  if (value === undefined) return undefined;
  const config = { ...object(value) };
  if (config.type === 'stdio' && config.args === undefined) config.args = [];
  for (const key of ['env', 'headers'])
    if (config[key] && Object.keys(object(config[key])).length === 0) delete config[key];
  return config;
}
export function sameClaudeEntry(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(normalizedClaudeEntry(left), normalizedClaudeEntry(right));
}
