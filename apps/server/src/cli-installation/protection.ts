import { cp, link, lstat, mkdir, mkdtemp, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { BackendError } from './backend-support';

export async function existing(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** 调用方只传入已验证的明确所有物。逐个删除，目录链接作为单个入口处理。 */
export async function removeOwnedTree(file: string): Promise<void> {
  const entry = await existing(file);
  if (!entry) return;
  if (!entry.isDirectory() || entry.isSymbolicLink()) return unlink(file);
  for (const name of await readdir(file)) await removeOwnedTree(path.join(file, name));
  await rmdir(file);
}

type Saved = { target: string; dir?: string; backup?: string; original?: string; replacement?: string };

function stamp(info: NonNullable<Awaited<ReturnType<typeof existing>>>) {
  return [info.dev, info.ino, info.ctimeMs, info.size].join('/');
}
export type Replacement = { target: string; staged: string };

async function save(target: string, move: boolean): Promise<Saved> {
  const entry = await existing(target);
  if (!entry) return { target };
  const dir = await mkdtemp(path.join(path.dirname(target), '.agentdeck-cli-'));
  const backup = path.join(dir, 'previous');
  try {
    if (move) await rename(target, backup);
    // 带多个硬链接的原生版本文件由替换入口的适配器管理，保留其 inode 供回滚。
    else if (entry.isFile() && entry.nlink > 1) await link(target, backup);
    else await cp(target, backup, { recursive: true, verbatimSymlinks: true });
    return { target, backup, dir, original: !move && !entry.isDirectory() ? stamp(entry) : undefined };
  } catch (error) {
    await removeOwnedTree(dir);
    throw error;
  }
}

async function fileId(file: string) {
  const info = await lstat(file, { bigint: true });
  return `${info.dev}/${info.ino}`;
}

async function restoreOne({ target, backup, dir, original, replacement }: Saved) {
  const current = await existing(target);
  if (dir && current && stamp(current) === original) return removeOwnedTree(dir);
  // 遇到第三方换入的对象或已失去的备份，要先停下，不能先删当前对象。
  if (current && replacement && (await fileId(target)) !== replacement) throw new Error('安装入口已被更换');
  if (backup) await lstat(backup);
  await removeOwnedTree(target);
  if (backup) await rename(backup, target);
  if (dir) await rmdir(dir);
}

async function restore(saved: Saved[]): Promise<void> {
  let failed = false;
  for (const item of saved.toReversed()) {
    try {
      await restoreOne(item);
    } catch {
      failed = true;
    } // 保留尚未恢复的备份，并尝试恢复其余入口。
  }
  if (failed) throw new BackendError('rollback_failed', '无法完整恢复原安装，已保留备份，请检查目录占用和写入权限。');
}

export const cleanupNotice = 'CLI 已验证可用，尚有占用或权限限制的临时文件待清理。';

async function discard(saved: Saved[]): Promise<string | undefined> {
  let notice: string | undefined;
  for (const { dir } of saved) {
    if (dir)
      try {
        await removeOwnedTree(dir);
      } catch {
        notice = cleanupNotice;
      }
  }
  return notice;
}

/** 原生安装器需要从旧入口启动，先复制保护范围，再运行直至最终验证结束。 */
export async function protectedMutation(
  targets: string[],
  operation: () => Promise<void>,
  beforeMutation?: () => Promise<void>,
): Promise<string | undefined> {
  const saved: Saved[] = [];
  try {
    for (const target of targets) saved.push(await save(target, false));
    await beforeMutation?.();
  } catch (error) {
    await discard(saved);
    throw error;
  }
  try {
    await operation();
  } catch (error) {
    await restore(saved);
    throw error;
  }
  return discard(saved);
}

/** npm 新版在同盘私有 prefix 只安装一次，再将包和命令入口移入最终位置。 */
export async function replaceFromStage(pairs: Replacement[], verify: () => Promise<void>): Promise<string | undefined> {
  for (const { staged } of pairs) await lstat(staged);
  const saved: Saved[] = [];
  try {
    for (const { target, staged } of pairs) {
      await mkdir(path.dirname(target), { recursive: true });
      const replacement = await fileId(staged);
      saved.push({ ...(await save(target, true)), replacement });
      await rename(staged, target);
    }
    await verify();
  } catch (error) {
    await restore(saved);
    throw error;
  }
  return discard(saved);
}
