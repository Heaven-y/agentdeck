import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import {
  applicationMenuTemplate,
  createWindowChrome,
  desktopChromeOptions,
  TITLE_BAR_COLORS,
} from '../../src/window/window-chrome';

const stylesheet = readFileSync(fileURLToPath(new URL('../../../web/src/styles.css', import.meta.url)), 'utf8');
/**
 * 取某主题下生效的 CSS 变量值，避免两份颜色各自漂移。
 * 暗色沿用 `@theme` 的默认值，浅色在 `:root:not([data-theme='dark'])` 里覆盖。
 */
function token(theme: 'light' | 'dark', name: string): string {
  const scope =
    theme === 'dark'
      ? stylesheet.slice(stylesheet.indexOf('@theme'), stylesheet.indexOf(":root[data-theme='dark']"))
      : stylesheet.slice(stylesheet.indexOf(":root:not([data-theme='dark'])"));
  const matched = scope.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!matched?.[1]) throw new Error(`未找到 ${name}`);
  return matched[1].toLowerCase();
}

const url = 'http://127.0.0.1:4317/';
function setup() {
  const frame = { url };
  const contents = { isDestroyed: () => false, mainFrame: frame, getZoomFactor: () => 1.25 };
  const owner = {
    isDestroyed: () => false,
    webContents: contents,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    setTitleBarOverlay: vi.fn(),
  };
  const popup = vi.fn(async () => {});
  return {
    frame,
    owner,
    popup,
    request: { sender: contents, senderFrame: frame },
    chrome: createWindowChrome(owner, url, popup, 'win32'),
  };
}

it('自定义顶栏保留原生系统按钮和 File/Edit/View/Window 菜单角色', () => {
  expect(desktopChromeOptions('win32')).toMatchObject({
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 40 },
    autoHideMenuBar: false,
  });
  expect(applicationMenuTemplate('win32').map(({ id, role }) => ({ id, role }))).toEqual([
    { id: 'file', role: undefined },
    { id: 'edit', role: 'editMenu' },
    { id: 'view', role: 'viewMenu' },
    { id: 'window', role: 'windowMenu' },
  ]);
  expect(desktopChromeOptions('darwin')).toHaveProperty('titleBarStyle', 'hiddenInset');
  expect(applicationMenuTemplate('darwin')[0]?.role).toBe('appMenu');
  expect(applicationMenuTemplate('win32')[0]?.submenu).toEqual([{ role: 'close', accelerator: 'Alt+F4' }]);
  expect(applicationMenuTemplate('darwin').find(({ id }) => id === 'file')?.submenu).toEqual([
    { role: 'close', accelerator: 'Command+Shift+W' },
  ]);
});

it('菜单只接受具名入口，位置按页面缩放转换并限制在窗口内', async () => {
  const { chrome, popup, request } = setup();
  await chrome.showMenu(request, 'edit', { x: 100, y: 32 });
  expect(popup).toHaveBeenCalledWith('edit', { x: 125, y: 40 });
  await chrome.showMenu(request, 'view', { x: -10, y: 10000 });
  expect(popup).toHaveBeenLastCalledWith('view', { x: 0, y: 800 });
  await expect(chrome.showMenu(request, 'execute-script', { x: 1, y: 1 })).rejects.toThrow('应用菜单不存在');
  await expect(chrome.showMenu(request, 'file', { x: NaN, y: 1 })).rejects.toThrow('菜单位置无效');
});

it('插件 frame、其他窗口和跨源页面不能调用菜单或主题能力', async () => {
  const { chrome, owner, frame, popup, request } = setup();
  for (const invalid of [
    { ...request, sender: {} },
    { ...request, senderFrame: { url } },
    { ...request, senderFrame: null },
  ]) {
    await expect(chrome.showMenu(invalid, 'file', { x: 1, y: 1 })).rejects.toThrow('当前页面不能操作');
    expect(() => chrome.setTheme(invalid, 'dark')).toThrow('当前页面不能操作');
  }
  frame.url = 'https://example.invalid/';
  await expect(chrome.showMenu(request, 'file', { x: 1, y: 1 })).rejects.toThrow('当前页面不能操作');
  frame.url = url;
  owner.isDestroyed = () => true;
  expect(() => chrome.setTheme(request, 'light')).toThrow('当前页面不能操作');
  expect(popup).not.toHaveBeenCalled();
  expect(owner.setTitleBarOverlay).not.toHaveBeenCalled();
});

it('同一时间只弹出一个菜单，关闭后可再次打开；主题只接受 light/dark', async () => {
  const { chrome, owner, popup, request } = setup();
  let release!: () => void;
  popup.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = chrome.showMenu(request, 'file', { x: 1, y: 1 });
  await chrome.showMenu(request, 'edit', { x: 1, y: 1 });
  expect(popup).toHaveBeenCalledTimes(1);
  release();
  await pending;
  await chrome.showMenu(request, 'view', { x: 1, y: 1 });
  expect(popup).toHaveBeenCalledTimes(2);
  chrome.setTheme(request, 'dark');
  expect(owner.setTitleBarOverlay).toHaveBeenCalledWith({ color: '#15171b', symbolColor: '#f9fafb' });
  expect(() => chrome.setTheme(request, { color: 'red' })).toThrow('标题栏主题无效');
});

it('窗口按钮区的底色与网页侧栏同色，两种主题都不留接缝', () => {
  expect(TITLE_BAR_COLORS.dark.color).toBe(token('dark', '--color-sidebar'));
  expect(TITLE_BAR_COLORS.light.color).toBe(token('light', '--color-sidebar'));
});
