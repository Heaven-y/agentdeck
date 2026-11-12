import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { NativeSkillImportInput } from '@agentdeck/shared/settings';
import { NativeResourceError } from '../agents/common/configuration/errors';
import { assertDirectoryUnchanged, inspectDirectory, MAX_CONFIG_BYTES, decodeUtf8 } from '../platform/files/safe-file';
import { nativeFileTransaction } from '../platform/files/transactions';
import { NativeManagementError } from './errors';

export const SKILL_LIMITS = { files: 128, bytes: 8 * 1024 * 1024, fileBytes: 1024 * 1024, depth: 6 } as const;
const identity = (a: Stats, b: Stats) =>
  a.ino === b.ino &&
  a.dev === b.dev &&
  a.birthtimeMs === b.birthtimeMs &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
export function skillName(name: string) {
  if (
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)
  )
    throw new NativeResourceError('invalid_request');
  return name;
}
export function skillRelative(file: string) {
  if (
    file.length > 512 ||
    file.includes('\\') ||
    file.split('/').length > SKILL_LIMITS.depth ||
    file
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[<>:"|?*]/.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new NativeResourceError('invalid_request');
  return file;
}
async function ordinaryBytes(file: string) {
  const before = await lstat(file);
  if (!before.isFile()) throw new NativeResourceError('unsafe_path');
  if (before.size > SKILL_LIMITS.fileBytes) throw new NativeResourceError('too_large');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!identity(before, await handle.stat())) throw new NativeResourceError('revision_conflict');
    const data = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < data.length) {
      const read = await handle.read(data, size, data.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== before.size || !identity(before, await handle.stat()) || !identity(before, await lstat(file)))
      throw new NativeResourceError('revision_conflict');
    return data.subarray(0, size);
  } finally {
    await handle.close();
  }
}
export async function snapshotSkillTree(directory: string) {
  const parents = await inspectDirectory(directory);
  if (!parents) throw new NativeResourceError('resource_missing');
  const items: Array<{ path: string; data: Buffer }> = [];
  let entries = 0;
  let total = 0;
  async function addFile(file: string) {
    if (items.length >= SKILL_LIMITS.files) throw new NativeResourceError('too_large');
    const data = await ordinaryBytes(path.join(directory, file));
    total += data.length;
    if (total > SKILL_LIMITS.bytes) throw new NativeResourceError('too_large');
    items.push({ path: file, data });
  }
  async function visit(relative: string, depth: number) {
    const current = path.join(directory, relative);
    const chain = await inspectDirectory(current);
    if (!chain) throw new NativeResourceError('revision_conflict');
    const handle = await opendir(current);
    for await (const entry of handle) {
      if (++entries > SKILL_LIMITS.files * 4) throw new NativeResourceError('too_large');
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      skillRelative(file);
      if (entry.isSymbolicLink()) throw new NativeResourceError('unsafe_path');
      if (entry.isDirectory()) {
        if (depth >= SKILL_LIMITS.depth - 1) throw new NativeResourceError('too_large');
        await visit(file, depth + 1);
      } else {
        await addFile(file);
      }
    }
    await assertDirectoryUnchanged(chain);
  }
  await visit('', 0);
  await assertDirectoryUnchanged(parents);
  const hash = createHash('sha256');
  for (const item of items.sort((a, b) => a.path.localeCompare(b.path)))
    hash.update(JSON.stringify([item.path, item.data.length])).update(item.data);
  return { revision: hash.digest('hex'), items };
}
export function decodeImport(input: NativeSkillImportInput) {
  skillName(input.name);
  if (!input.files.length || input.files.length > SKILL_LIMITS.files) throw new NativeResourceError('too_large');
  const seen = new Set<string>();
  let total = 0;
  const files = input.files.map((file) => {
    skillRelative(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new NativeResourceError('invalid_request');
    seen.add(key);
    if (
      file.contentBase64.length > Math.ceil(SKILL_LIMITS.fileBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)
    )
      throw new NativeResourceError(
        file.contentBase64.length > SKILL_LIMITS.fileBytes ? 'too_large' : 'invalid_request',
      );
    const data = Buffer.from(file.contentBase64, 'base64');
    total += data.length;
    if (data.length > SKILL_LIMITS.fileBytes || total > SKILL_LIMITS.bytes) throw new NativeResourceError('too_large');
    if (file.path === 'SKILL.md') {
      if (data.length > MAX_CONFIG_BYTES) throw new NativeResourceError('too_large');
      decodeUtf8(data);
    }
    return { path: file.path, data };
  });
  if (!seen.has('skill.md') || !files.some((file) => file.path === 'SKILL.md'))
    throw new NativeResourceError('invalid_request');
  return files;
}
async function absent(file: string) {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat) throw new NativeResourceError('revision_conflict');
}
/** 完整目录先在同一安全父目录内组装，再一次更名；不执行导入内容。 */
export async function importSkillTree(root: string, input: NativeSkillImportInput) {
  const files = decodeImport(input);
  const destination = path.join(root, input.name);
  return nativeFileTransaction(destination, async () => {
    const parents = (await inspectDirectory(root, true))!;
    await absent(destination);
    const temporary = path.join(root, `.import-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      for (const file of files) {
        const target = path.join(temporary, file.path);
        const chain = (await inspectDirectory(path.dirname(target), true))!;
        await assertDirectoryUnchanged(chain);
        const handle = await open(target, 'wx', 0o600);
        try {
          await handle.writeFile(file.data);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await snapshotSkillTree(temporary);
      await assertDirectoryUnchanged(parents);
      await absent(destination);
      await rename(temporary, destination);
    } finally {
      await assertDirectoryUnchanged(parents);
      // 只清理由本次生成、位于已复核父目录内的暂存路径；rm 不跟随链接。
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
export async function deleteSkillTree(directory: string, revision: string) {
  return nativeFileTransaction(directory, async () => {
    const parents = (await inspectDirectory(path.dirname(directory)))!;
    if ((await snapshotSkillTree(directory)).revision !== revision) throw new NativeResourceError('revision_conflict');
    await assertDirectoryUnchanged(parents);
    const quarantine = path.join(path.dirname(directory), `.deleted-${randomUUID()}`);
    const original = await lstat(directory);
    await rename(directory, quarantine);
    try {
      await assertDirectoryUnchanged(parents);
      if ((await snapshotSkillTree(quarantine)).revision !== revision)
        throw new NativeResourceError('revision_conflict');
    } catch (error) {
      // 复核抛错也必须恢复；无法安全恢复时保留隔离内容，不覆盖新占用的原位置。
      try {
        await assertDirectoryUnchanged(parents);
        const current = await lstat(quarantine);
        if (
          !current.isDirectory() ||
          current.dev !== original.dev ||
          current.ino !== original.ino ||
          current.birthtimeMs !== original.birthtimeMs
        )
          throw new NativeResourceError('unsafe_path');
        await absent(directory);
        await rename(quarantine, directory);
      } catch {
        throw new NativeManagementError('result_unconfirmed');
      }
      throw error;
    }
    await rm(quarantine, { recursive: true, force: true });
  });
}
