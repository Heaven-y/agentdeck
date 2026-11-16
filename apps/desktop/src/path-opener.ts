import path from 'node:path';
import { desktopRequestAllowed, type DesktopOwner, type DesktopRequest } from './window-access';
/** `shell.openPath` 返回空串表示成功，否则是系统给出的原因。 */
type OpenPath = (target: string) => Promise<string>;

function targetDirectory(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 32_767 || input.includes('\0'))
    throw new Error('路径无效，请重新选择。');
  const value = input.trim();
  if (!path.isAbsolute(value)) throw new Error('只能打开本机的完整路径。');
  return path.resolve(value);
}

/**
 * 在系统文件管理器中打开项目目录。
 * 只接受绝对路径；页面访问限制与目录选择一致，插件 iframe 与其他窗口不能用。
 */
export function createPathOpener(owner: DesktopOwner, initialUrl: string, open: OpenPath) {
  return async (request: DesktopRequest, input?: unknown): Promise<boolean> => {
    if (!desktopRequestAllowed(owner, initialUrl, request)) throw new Error('当前页面不能打开本机路径。');
    const target = targetDirectory(input);
    const failure = await open(target);
    if (failure) throw new Error('无法在文件管理器中打开该目录。');
    return true;
  };
}
