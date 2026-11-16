import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') throw error;
}

/** 配置可能含敏感模型参数，只通过本次启动的私有文件传递，不进入 argv 或日志。 */
export async function prepareNativeSettings(settings: object): Promise<{ path: string; close(): Promise<void> }> {
  const content = JSON.stringify(settings);
  const directory = await mkdtemp(path.join(tmpdir(), 'agentdeck-agy-settings-'));
  const file = path.join(directory, 'settings.json');
  const close = async () => {
    await unlink(file).catch(ignoreMissing);
    await rmdir(directory).catch(ignoreMissing);
  };
  try {
    await writeFile(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { path: file, close };
  } catch (error) {
    await close();
    throw error;
  }
}
