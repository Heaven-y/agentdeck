import type { AgentDeckBridge } from '../../../desktop/src/bridge';

declare global {
  interface Window {
    agentDeck?: AgentDeckBridge;
  }
}

/** 浏览器调试以及旧桌面壳没有该能力时，继续使用路径输入。 */
export function desktopDirectoryPicker() {
  return window.agentDeck?.selectDirectory;
}

export function desktopChrome() {
  return window.agentDeck?.chrome;
}

export function desktopAntigravityLogin() {
  return window.agentDeck?.openAntigravityLogin;
}

/** 浏览器调试与旧桌面壳没有打开路径的能力，此时界面不显示该入口。 */
export function desktopPathOpener() {
  return window.agentDeck?.openPath;
}

/** Windows 叫资源管理器，macOS 是访达；其它平台用中性说法。 */
export function revealLabel(platform = window.agentDeck?.platform): string {
  if (platform === 'win32') return '在资源管理器中打开';
  if (platform === 'darwin') return '在访达中显示';
  return '在文件管理器中打开';
}
