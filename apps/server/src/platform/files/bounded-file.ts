import { constants, type Stats } from 'node:fs';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { inspectDirectory, assertDirectoryUnchanged } from './safe-file';
/** 有界二进制读取，不跟随文件或父目录链接，并核对读取期间身份未变。 */
export async function readBoundedFile(file: string, limit: number): Promise<Buffer> {
  const directories = await inspectDirectory(path.dirname(file));
  if (!directories) throw new Error('文件不存在');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error('文件格式或大小无效');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assertOpened(before, opened);
    const buffer = await readBytes(handle, Math.min(limit + 1, before.size + 1));
    const after = await handle.stat();
    assertRead(before, after, buffer.length, limit);
    await assertDirectoryUnchanged(directories);
    return buffer;
  } finally {
    await handle.close();
  }
}

function assertOpened(before: Stats, opened: Stats) {
  if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
    throw new Error('文件已变化');
}
function assertRead(before: Stats, after: Stats, size: number, limit: number) {
  if (size > limit || after.size !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
    throw new Error('文件已变化');
}
async function readBytes(handle: FileHandle, limit: number) {
  const buffer = Buffer.alloc(limit);
  let size = 0;
  while (size < buffer.length) {
    const result = await handle.read(buffer, size, buffer.length - size, size);
    if (!result.bytesRead) break;
    size += result.bytesRead;
  }
  return buffer.subarray(0, size);
}
