import { expect, it, vi } from 'vitest';
import { createAntigravityLoginHandler } from '../../src/window/antigravity-login';

it('仅允许同源主窗口启动 AGY 登录，终端关闭前重复请求共用一次启动', async () => {
  const url = 'http://localhost';
  const frame = { url };
  const sender = { isDestroyed: () => false, mainFrame: frame };
  const request = { sender, senderFrame: frame };
  let finish!: (completed: boolean) => void;
  const launch = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
  const login = createAntigravityLoginHandler({ isDestroyed: () => false, webContents: sender }, url, launch);

  await expect(login({ ...request, senderFrame: { url } })).rejects.toThrow();
  frame.url = 'https://example.invalid';
  await expect(login(request)).rejects.toThrow();
  expect(launch).not.toHaveBeenCalled();

  frame.url = url;
  const first = login(request);
  const duplicate = login(request);
  expect(launch).toHaveBeenCalledTimes(1);
  finish(false);
  await expect(Promise.all([first, duplicate])).resolves.toEqual([false, false]);

  const retry = login(request);
  finish(true);
  await expect(retry).resolves.toBe(true);
  expect(launch).toHaveBeenCalledTimes(2);
});
