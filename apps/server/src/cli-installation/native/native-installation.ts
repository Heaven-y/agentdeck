import { lstat, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { type BackendContext, installationEnvironment, samePath, VERSION } from '../backend-support';
import type { CliInstallation } from '../types';
import { binaryTarget } from './native-binary';
import { cleanupAgyHistory } from './native-history';
import {
  codexInventory,
  codexProtection,
  codexStore,
  fixedDirectory,
  isNativeEntry,
  releaseItem,
  unsafeLayout,
  type ReleaseItem,
} from './native-layout';
import { assertInstallationIdle } from '../transaction/occupancy';

type Switched = { previous: string; next: string } & (
  { agent: 'claude'; identity: string } | { agent: 'codex'; inventory: ReleaseItem[] }
);
const switched = new WeakMap<CliInstallation, Switched>();
const equal = (a: string, b: string) => samePath(a, b, 'win32');
// 切走硬链接会改变链接数。身份比较保留文件号、创建时间和内容修改信息。
const identity = (info: Awaited<ReturnType<typeof bigintStat>>) =>
  [info.dev, info.ino, info.birthtimeNs, info.mtimeNs, info.size].join('/');
const bigintStat = (file: string) => stat(file, { bigint: true });

async function recordCodex(
  context: BackendContext,
  installation: CliInstallation,
  env: NodeJS.ProcessEnv,
  next: string,
) {
  const previous = await realpath(codexStore(context, env).current);
  if (equal(previous, next)) return;
  const inventory = await codexInventory(previous).catch(() => undefined);
  if (inventory) switched.set(installation, { agent: 'codex', previous, next, inventory });
}

/** 记录取得保护时正在使用的版本，只授予同一次操作在验证成功后的清理权限。 */
export async function nativeProtectionPaths(
  context: BackendContext,
  installation: CliInstallation,
  version: string,
): Promise<string[]> {
  if (!installation.installed || installation.source !== 'native') return [];
  if (!VERSION.test(version) || version.length > 100) throw unsafeLayout();
  const env = installationEnvironment(await context.environment(installation.agent));
  const command = installation.command;
  if (!command || command.args.length || !(await isNativeEntry(context, env, installation.agent, command.command)))
    throw unsafeLayout();
  if (installation.agent === 'codex') {
    const { paths, release } = await codexProtection(context, installation, env, version);
    if (!switched.has(installation)) await recordCodex(context, installation, env, release);
    return paths;
  }
  return protectBinary(context, installation, version);
}

async function protectBinary(context: BackendContext, installation: CliInstallation, version: string) {
  const target = await binaryTarget(context, installation, version);
  if (target.previous && target.store && !equal(target.previous, target.store) && !switched.has(installation)) {
    switched.set(installation, {
      agent: 'claude',
      previous: target.previous,
      next: target.store,
      identity: identity(await bigintStat(target.previous)),
    });
  }
  return target.store ? [target.entry, target.store] : [target.entry];
}

async function switchedToTarget(context: BackendContext, env: NodeJS.ProcessEnv, entry: string, record: Switched) {
  if (
    !(await isNativeEntry(context, env, record.agent, entry)) ||
    !(await fixedDirectory(path.dirname(record.previous)))
  )
    return false;
  if (record.agent === 'codex') {
    const next = await realpath(record.next);
    return (
      (await fixedDirectory(record.next)) &&
      !equal(record.previous, next) &&
      equal(await realpath(codexStore(context, env).current), next)
    );
  }
  const target = await lstat(record.next, { bigint: true });
  const active = await bigintStat(entry);
  return target.isFile() && active.dev === target.dev && active.ino === target.ino;
}
async function oldClaude(record: Extract<Switched, { agent: 'claude' }>) {
  const item = await lstat(record.previous, { bigint: true });
  return item.isFile() && item.nlink === 1n && identity(item) === record.identity;
}
async function oldCodex(record: Extract<Switched, { agent: 'codex' }>) {
  const inventory = await codexInventory(record.previous).catch(() => undefined);
  return !!inventory && JSON.stringify(inventory) === JSON.stringify(record.inventory);
}
async function cleanupSwitched(context: BackendContext, env: NodeJS.ProcessEnv, entry: string, record: Switched) {
  const valid = async () =>
    (await switchedToTarget(context, env, entry, record)) &&
    (record.agent === 'claude' ? await oldClaude(record) : await oldCodex(record));
  if (!(await valid())) return;
  await assertInstallationIdle(context, [record.previous], AbortSignal.timeout(15_000));
  if (!(await valid())) return;
  if (record.agent === 'claude') return unlink(record.previous);
  for (const item of record.inventory) {
    if (!(await fixedDirectory(path.dirname(item.file))) || (await releaseItem(item.file)).identity !== item.identity)
      return;
    if (item.directory) await rmdir(item.file);
    else await unlink(item.file);
  }
}

export async function cleanupNativeHistory(context: BackendContext, installation: CliInstallation): Promise<void> {
  if (installation.source !== 'native' || !installation.command) return;
  const env = installationEnvironment(await context.environment(installation.agent));
  const entry = installation.command.command;
  const record = switched.get(installation);
  switched.delete(installation);
  if (record) return cleanupSwitched(context, env, entry, record);
  if (installation.agent === 'antigravity' && (await isNativeEntry(context, env, 'antigravity', entry)))
    await cleanupAgyHistory(context, path.dirname(entry), env);
}
