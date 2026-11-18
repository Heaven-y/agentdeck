import { readlink } from 'node:fs/promises';
import { existing } from '../transaction/protection';
import path from 'node:path';
import { resolveNodeExecutable, type ResolvedCommand } from '../../platform/process/executable';
import type { AgentKind } from '@agentdeck/shared/conversation';
import {
  canonical,
  commandFingerprint,
  objectValue,
  PACKAGES,
  pathDirectories,
  readSmallFile,
  samePath,
  type BackendContext,
} from '../backend-support';

type PackageInfo = { root: string; manifest: Record<string, unknown>; text: string };
export type NpmInstallation = { command: ResolvedCommand; prefix: string; identity: unknown };

async function packageInfo(root: string, name: string): Promise<PackageInfo | undefined> {
  try {
    const text = await readSmallFile(path.join(root, 'package.json'));
    const manifest = objectValue(JSON.parse(text));
    if (manifest?.name === name) return { root, manifest, text };
  } catch {
    /* 无法验证的包不能作为自动更新目标。 */
  }
  return undefined;
}

function declaredBin(info: PackageInfo, name: string): string | undefined {
  const bin = typeof info.manifest.bin === 'string' ? info.manifest.bin : objectValue(info.manifest.bin)?.[name];
  if (typeof bin !== 'string' || path.isAbsolute(bin)) return undefined;
  const resolved = path.resolve(info.root, bin);
  const relative = path.relative(info.root, resolved);
  return relative.startsWith('..') ? undefined : resolved;
}

async function npmCommand(
  dir: string,
  context: BackendContext,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedCommand | undefined> {
  const entry = await canonical(path.join(dir, context.platform === 'win32' ? 'npm.cmd' : 'npm'));
  if (!entry) return undefined;
  const root = context.platform === 'win32' ? path.join(dir, 'node_modules/npm') : path.dirname(path.dirname(entry));
  const info = await packageInfo(root, 'npm');
  if (!info) return undefined;
  const bin = declaredBin(info, 'npm');
  if (!bin || !(await canonical(bin))) return undefined;
  if (context.platform !== 'win32' && !samePath(entry, (await canonical(bin))!, context.platform)) return undefined;
  // npm.cmd 不经 shell 执行：使用本机 Node 和已核对包名的 npm-cli.js。
  return { command: resolveNodeExecutable(dir, env), args: [bin] };
}

export async function discoverNpm(
  context: BackendContext,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<NpmInstallation | undefined> {
  for (const dir of pathDirectories(env, context.platform)) {
    try {
      const command = await npmCommand(dir, context, env);
      if (!command) continue;
      const result = await context.run(command.command, [...command.args, 'prefix', '--global'], {
        env,
        signal,
        timeoutMs: 8_000,
        outputCap: 16 * 1024,
      });
      const prefix = result.stdout.toString('utf8').trim();
      if (result.exitCode !== 0 || !path.isAbsolute(prefix) || /[\r\n\0]/.test(prefix)) return undefined;
      return { command, prefix: path.resolve(prefix), identity: await commandFingerprint(command) };
    } catch {
      /* 只跳过不可用的 npm；不执行任意包装脚本。 */
    }
  }
  return undefined;
}

export function npmBinDirectory(npm: NpmInstallation, platform: NodeJS.Platform): string {
  return platform === 'win32' ? npm.prefix : path.join(npm.prefix, 'bin');
}

async function matchesPackageEntry(
  info: PackageInfo,
  command: ResolvedCommand,
  input: { agent: AgentKind; context: BackendContext },
): Promise<boolean> {
  const bin = declaredBin(info, input.agent);
  if (!bin || command.args.length > 1) return false;
  if (command.args.length === 1 && !/^node(?:\.exe)?$/i.test(path.basename(command.command))) return false;
  const expected = await canonical(bin);
  const actual = await canonical(command.args[0] ?? command.command);
  if (!expected || !actual || !samePath(expected, actual, input.context.platform)) return false;
  return isPackageFile(info.root, actual);
}

async function isPackageFile(dir: string, file: string): Promise<boolean> {
  const root = await canonical(dir);
  if (!root) return false;
  const relative = path.relative(root, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export type OfficialPackage = { identity: string; version: unknown };
export async function officialNpmSource(input: {
  agent: AgentKind;
  command: ResolvedCommand;
  npm: NpmInstallation;
  context: BackendContext;
}): Promise<OfficialPackage | undefined> {
  const { agent, command, npm, context } = input;
  if (agent === 'antigravity') return undefined;
  const root = path.join(
    npm.prefix,
    context.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    PACKAGES[agent],
  );
  const info = await packageInfo(root, PACKAGES[agent]);
  if (!info) return undefined;
  if (!(await matchesPackageEntry(info, command, { agent, context }))) return undefined;
  // 对比真实入口与官方包声明的 bin，同时绑定完整清单；不依赖路径片段推断来源。
  return { identity: info.text, version: info.manifest.version };
}
/** 入口已损坏时仍可用当前全局位置和包清单确定修复对象。 */
export async function brokenNpmPackage(
  agent: AgentKind,
  npm: NpmInstallation | undefined,
  context: BackendContext,
): Promise<OfficialPackage | undefined> {
  if (!npm || agent === 'antigravity') return undefined;
  const root = path.join(
    npm.prefix,
    context.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    PACKAGES[agent],
  );
  const info = await packageInfo(root, PACKAGES[agent]);
  if (!info || !declaredBin(info, agent)) return undefined;
  return { identity: info.text, version: info.manifest.version };
}
/** 除正在使用的入口外，npm 还会生成其它 shell 的同名入口；不能据文件名认领它们。 */
export async function ownsNpmLaunchers(
  root: string,
  launchers: string[],
  agent: 'claude' | 'codex',
  platform: NodeJS.Platform,
): Promise<boolean> {
  const info = await packageInfo(root, PACKAGES[agent]);
  if (!info) return false;
  const entry = declaredBin(info, agent);
  if (!entry) return false;
  for (const file of launchers) {
    const link = await existing(file);
    if (!link) continue;
    if (link.isSymbolicLink()) {
      if (!samePath(path.resolve(path.dirname(file), await readlink(file)), entry, platform)) return false;
    } else if (!link.isFile() || platform !== 'win32' || !shimPointsTo(await readSmallFile(file), file, entry))
      return false;
  }
  return true;
}

function shimPointsTo(contents: string, file: string, entry: string): boolean {
  const directory = path.dirname(file);
  const text = contents.replace(/%(?:~dp0|dp0%)|\$(?:basedir|psscriptroot)/gi, directory + path.sep);
  return [...text.matchAll(/["']([^"'\r\n]+)["']/g)].some((match) => {
    const quoted = match[1]!;
    return path.isAbsolute(quoted) && samePath(quoted, entry, 'win32');
  });
}
