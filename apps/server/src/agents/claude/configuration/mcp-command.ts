import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { NativeResourceError } from '../../common/configuration/errors';
import { readNativeConfigSource } from '../../../native-management/config';
import { NativeManagementError } from '../../../native-management/errors';
import {
  isConfigObject,
  object,
  serverMap,
  type McpContext,
  type McpSource,
} from '../../../native-management/mcp/mcp-types';
import { assertDirectoryUnchanged, inspectDirectory, readConfigFile } from '../../../platform/files/safe-file';
import { resolveLocalCommand, type ResolvedCommand } from '../../../platform/process/executable';
import { runProcess, type ProcessRunner } from '../../../platform/process/run';

function absentOrEmptyMap(value: unknown): boolean {
  return value === undefined || (isConfigObject(value) && !Object.keys(value).length);
}

/** remove 可删除历史名称；add-json 不接受点号，也没有配置 stdin。 */
export function canSaveClaudeMcp(name: string, value: Record<string, unknown>): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name) &&
    Object.keys(value).every((key) => ['type', 'command', 'args', 'env', 'headers'].includes(key)) &&
    (value.args === undefined || (Array.isArray(value.args) && value.args.length === 0)) &&
    absentOrEmptyMap(value.env) &&
    absentOrEmptyMap(value.headers)
  );
}

function normalizedClaudeEntry(value: unknown) {
  if (value === undefined) return undefined;
  const config = { ...object(value) };
  if (config.type === 'stdio' && config.args === undefined) config.args = [];
  for (const key of ['env', 'headers']) if (absentOrEmptyMap(config[key])) delete config[key];
  return config;
}

export async function writeClaudeMcp(
  context: McpContext,
  source: McpSource,
  { name, value }: { name: string; value?: Record<string, unknown> },
  runner: ProcessRunner = runProcess,
) {
  const scope = source.commandScope;
  if (!scope || (value && !canSaveClaudeMcp(name, value))) throw new NativeManagementError('unsupported_action');
  let cli: ResolvedCommand;
  try {
    cli = resolveLocalCommand('claude', context.env);
  } catch {
    throw new NativeManagementError('native_unavailable');
  }
  const parents = await inspectDirectory(path.dirname(source.file), true);
  let revision = source.revision;
  let started = false;
  const run = async (args: string[], expected?: Record<string, unknown>) => {
    if ((await readConfigFile(source.file)).revision !== revision) throw new NativeResourceError('revision_conflict');
    await assertDirectoryUnchanged(parents!);
    started = true;
    const result = await runner(cli.command, [...cli.args, 'mcp', ...args, '--scope', scope], {
      cwd: context.project?.dir ?? context.homeDir,
      env: context.env,
      timeoutMs: 15000,
      outputCap: 64 * 1024,
    });
    if (result.exitCode !== 0) throw new NativeManagementError('mcp_change_unconfirmed');
    const after = await readNativeConfigSource(source.file, source.scope);
    await assertDirectoryUnchanged(parents!);
    const entries = serverMap({ ...source, ...after });
    if (
      after.revision === 'missing' ||
      (expected === undefined
        ? Object.hasOwn(entries, name)
        : !Object.hasOwn(entries, name) ||
          !isDeepStrictEqual(normalizedClaudeEntry(entries[name]), normalizedClaudeEntry(expected)))
    )
      throw new NativeManagementError('mcp_change_unconfirmed');
    revision = after.revision;
  };
  // 原生 add-json 不覆盖已存在条目。确认同一作用域移除后，才能用新 revision 继续添加。
  try {
    if (Object.hasOwn(serverMap(source), name)) await run(['remove', name]);
    if (value) await run(['add-json', name, JSON.stringify(value)], value);
  } catch (error) {
    if (started) throw new NativeManagementError('mcp_change_unconfirmed');
    throw error;
  }
}
