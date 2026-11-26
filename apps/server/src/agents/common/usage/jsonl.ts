import { UsageReadError } from './contracts';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { inspectDirectory, assertDirectoryUnchanged } from '../../../platform/files/safe-file';

/** 原生文件只读有界扫描；不把正文传给公共用量服务。 */
export async function readUsageLines(file: string, visit: (entry: unknown) => void, signal?: AbortSignal) {
  const directories = await inspectDirectory(path.dirname(file));
  const before = await lstat(file);
  if (!directories || before.isSymbolicLink() || !before.isFile()) throw new UsageReadError('原生用量文件无法读取。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new UsageReadError('原生记录已变化，请重新同步。');
    await scanLines(handle, before.size, visit, signal);
    await assertDirectoryUnchanged(directories);
    const after = await handle.stat();
    if (after.size < before.size || after.ino !== before.ino) throw new UsageReadError('原生记录已变化，请重新同步。');
    // 运行中尚未换行的尾部留待下次读取，不把半条记录当一次生成。
    return `${before.ino}:${before.size}:${before.mtimeMs}`;
  } finally {
    await handle.close();
  }
}

async function scanLines(handle: FileHandle, size: number, visit: (entry: unknown) => void, signal?: AbortSignal) {
  let pending: Buffer[] = [],
    offset = 0;
  const buffer = Buffer.alloc(128 * 1024);
  while (offset < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new UsageReadError('原生记录已变化，请重新同步。');
    offset += bytesRead;
    let start = 0,
      end: number;
    while ((end = buffer.subarray(0, bytesRead).indexOf(10, start)) >= 0) {
      pending.push(Buffer.from(buffer.subarray(start, end)));
      const line = Buffer.concat(pending).toString('utf8');
      pending = [];
      start = end + 1;
      if (line.trim()) visit(parseLine(line));
    }
    if (start < bytesRead) pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new UsageReadError('原生记录格式不完整，请稍后同步。');
  }
}
