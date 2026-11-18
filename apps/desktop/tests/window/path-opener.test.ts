import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createPathOpener } from '../../src/window/path-opener';

const url = 'http://127.0.0.1:4317/';
const directory = path.join(os.tmpdir(), 'agentdeck-opener', 'demo');

function setup() {
  const frame = { url };
  const contents = { isDestroyed: () => false, mainFrame: frame };
  const owner = { isDestroyed: () => false, webContents: contents };
  const open = vi.fn<(target: string) => Promise<string>>().mockResolvedValue('');
  return {
    frame,
    owner,
    open,
    request: { sender: contents, senderFrame: frame },
    opener: createPathOpener(owner, url, open),
  };
}

it('在主窗口同源主 frame 打开绝对路径目录', async () => {
  const { open, request, opener } = setup();
  await expect(opener(request, directory)).resolves.toBe(true);
  expect(open).toHaveBeenCalledExactlyOnceWith(path.resolve(directory));
});

it('插件 iframe、其他窗口与外部页面都不能打开本机路径', async () => {
  const { frame, owner, open, request, opener } = setup();
  for (const invalid of [
    { ...request, sender: {} },
    { ...request, senderFrame: { url } },
    { ...request, senderFrame: null },
  ])
    await expect(opener(invalid, directory)).rejects.toThrow('当前页面不能打开');
  frame.url = 'https://example.invalid/';
  await expect(opener(request, directory)).rejects.toThrow('当前页面不能打开');
  frame.url = url;
  owner.isDestroyed = () => true;
  await expect(opener(request, directory)).rejects.toThrow('当前页面不能打开');
  expect(open).not.toHaveBeenCalled();
});

it('拒绝相对路径与非法参数，系统打开失败时上报而不是静默成功', async () => {
  const { open, request, opener } = setup();
  for (const invalid of [undefined, '', `C:\\demo\0x`, 42])
    await expect(opener(request, invalid)).rejects.toThrow('路径无效');
  for (const relative of ['demo', 'demo/../etc']) await expect(opener(request, relative)).rejects.toThrow('完整路径');
  open.mockResolvedValueOnce('系统未找到该目录');
  await expect(opener(request, directory)).rejects.toThrow('无法在文件管理器中打开');
});
