import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  link,
  lstat,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BackendError, type BackendContext } from '../backend-support';
import { agyManifest, claudeAsset } from '../discovery/catalog';
import { claudeVersions, fixedDirectory, unsafeLayout, versionFile } from './native-layout';
import { assertInstallationIdle } from '../transaction/occupancy';
import { existing } from '../transaction/protection';
import type { CliInstallation } from '../types';

type BinaryTarget = { entry: string; previous?: string; store?: string; link?: 'file' | 'hard' };
// 创建回滚硬链接可能更新 ctime。对这种入口绑定实际文件与内容，备份本身不应制造身份冲突。
export async function hardlinkFingerprint(installation: CliInstallation, signal?: AbortSignal) {
  if (installation.agent !== 'claude' || installation.source !== 'native' || !installation.command) return;
  const file = installation.command.command;
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.nlink < 2n) return;
  const digest = createHash('sha256');
  await pipeline(createReadStream(file), digest, { signal });
  return [
    await realpath(file),
    info.dev,
    info.ino,
    info.birthtimeNs,
    info.mtimeNs,
    info.size,
    digest.digest('hex'),
  ].map(String);
}
async function hardlinkVersion(entry: string, versions: string) {
  const active = await stat(entry, { bigint: true });
  if (active.nlink === 1n) return;
  if (!(await fixedDirectory(versions))) throw unsafeLayout();
  for (const name of await readdir(versions)) {
    if (!versionFile(name)) continue;
    const info = await lstat(path.join(versions, name), { bigint: true });
    if (info.isFile() && active.dev === info.dev && active.ino === info.ino) return name;
  }
  throw unsafeLayout();
}
export async function binaryTarget(
  context: BackendContext,
  installation: CliInstallation,
  version: string,
): Promise<BinaryTarget> {
  const entry = installation.command!.command;
  if (installation.agent === 'antigravity') return { entry };
  const versions = claudeVersions(context);
  const symbolic = (await lstat(entry)).isSymbolicLink();
  const previous = symbolic ? path.basename(await realpath(entry)) : await hardlinkVersion(entry, versions);
  if (!previous) return { entry };
  if (!(await fixedDirectory(versions))) throw unsafeLayout();
  const store = path.join(versions, version + (/\.exe$/i.test(previous) ? '.exe' : ''));
  const candidate = await existing(store);
  const oldFile = path.join(versions, previous);
  if (candidate && (!candidate.isFile() || path.relative(store, oldFile) !== '')) throw unsafeLayout();
  return { entry, store, previous: oldFile, link: symbolic ? 'file' : 'hard' };
}

type Asset = { version: string; url: string; checksum: string };
async function download(context: BackendContext, asset: Asset, file: string, signal: AbortSignal) {
  // 仅使用已校验的官方清单 URL。流式写入同盘私有文件，完整校验之前不动现有入口。
  const response = await context.fetch(asset.url, { redirect: 'error', signal });
  if (!response.ok || !response.body) throw new BackendError('download_failed', '官方下载未完成，请稍后重试。');
  const hash = createHash(asset.checksum.length === 128 ? 'sha512' : 'sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > 1024 ** 3) return done(new BackendError('response_limit', '官方程序超过大小上限。'));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(file, { flags: 'wx', mode: 0o700 }), {
    signal,
  });
  if (size === 0 || hash.digest('hex') !== asset.checksum)
    throw new BackendError('checksum_failed', '官方程序校验失败，已保留当前安装。');
}
async function activate(target: BinaryTarget, file: string) {
  if (!target.store) return rename(file, target.entry);
  const name = path.join(path.dirname(target.entry), `.agentdeck-${randomUUID()}`);
  // 新版本文件和启动入口分别通过 rename 切换，旧版本文件供已有会话继续使用。
  await rename(file, target.store);
  if (target.link === 'hard') await link(target.store, name);
  else {
    const old = await readlink(target.entry);
    await symlink(path.isAbsolute(old) ? target.store : path.relative(path.dirname(name), target.store), name, 'file');
  }
  try {
    await rename(name, target.entry);
  } finally {
    await unlink(name).catch(ignoreMissing);
  }
}
function ignoreMissing(error: NodeJS.ErrnoException) {
  if (error.code !== 'ENOENT') throw error;
}
async function binaryIdentity(paths: string[]) {
  const ids = await Promise.all(
    paths.map(async (file) => {
      if (!(await fixedDirectory(path.dirname(file)))) throw unsafeLayout();
      const item = await lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      return item
        ? [await realpath(file), String(item.dev), String(item.ino), String(item.ctimeNs), String(item.size)]
        : null;
    }),
  );
  return JSON.stringify(ids);
}
export async function updateNativeBinary(
  context: BackendContext,
  installation: CliInstallation,
  version: string,
  signal: AbortSignal,
) {
  const target = await binaryTarget(context, installation, version);
  const paths = [target.entry, ...(target.previous ? [target.previous] : []), ...(target.store ? [target.store] : [])];
  const identity = await binaryIdentity(paths);
  const asset =
    installation.agent === 'claude' ? await claudeAsset(context, version, signal) : await agyManifest(context, signal);
  if (asset.version !== version) throw new BackendError('release_changed', '官方目标版本已变化，请重新检查更新。');
  const dir = await mkdtemp(path.join(path.dirname(target.store ?? target.entry), '.agentdeck-download-'));
  const file = path.join(dir, 'payload.exe');
  try {
    await download(context, asset, file, signal);
    await assertInstallationIdle(context, paths, signal);
    if (identity !== (await binaryIdentity(paths))) throw unsafeLayout();
    signal.throwIfAborted();
    await activate(target, file);
  } finally {
    await unlink(file).catch(ignoreMissing);
    await rmdir(dir);
  }
}
