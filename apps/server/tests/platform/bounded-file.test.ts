import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readBoundedFile } from '../../src/platform/files/bounded-file';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
afterEach(() => vi.restoreAllMocks());
it('有界读取拒绝超额、非文件与打开前后的替换，正常零字节和上限文件可读', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agentdeck-bounded-'));
  const file = path.join(root, 'data');
  try {
    await fs.writeFile(file, '');
    expect(await readBoundedFile(file, 4)).toEqual(Buffer.alloc(0));
    await fs.writeFile(file, 'abcd');
    expect((await readBoundedFile(file, 4)).toString()).toBe('abcd');
    await expect(readBoundedFile(file, 3)).rejects.toThrow();
    await expect(readBoundedFile(root, 99)).rejects.toThrow();
    await expect(readBoundedFile(path.join(root, 'missing', 'data'), 99)).rejects.toThrow();
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(file, file + '.old');
      await fs.writeFile(file, 'efgh');
      return original(...args);
    });
    await expect(readBoundedFile(file, 4)).rejects.toThrow('变化');
    vi.restoreAllMocks();
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await original(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs) => {
        await fs.appendFile(file, 'i');
        return read(...readArgs);
      });
      return handle;
    });
    await expect(readBoundedFile(file, 4)).rejects.toThrow('变化');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
