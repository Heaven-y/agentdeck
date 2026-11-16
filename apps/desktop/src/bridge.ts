/** 预加载仅暴露桌面所需的具名能力，不把 IPC 通道交给页面。 */
export const SELECT_DIRECTORY_CHANNEL = 'agentdeck:select-directory';
export const OPEN_PATH_CHANNEL = 'agentdeck:open-path';
export const APP_MENU_CHANNEL = 'agentdeck:app-menu';
export const TITLE_BAR_THEME_CHANNEL = 'agentdeck:title-bar-theme';
export const SESSION_LINK_CHANNEL = 'agentdeck:session-link';
export const INITIAL_SESSION_LINK_CHANNEL = 'agentdeck:initial-session-link';

export type AppMenuName = 'file' | 'edit' | 'view' | 'window';
export type AppMenuPosition = { x: number; y: number };
export type DesktopChrome = {
  showMenu(name: AppMenuName, position: AppMenuPosition): Promise<void>;
  setTheme(theme: 'light' | 'dark'): Promise<void>;
};

export type AgentDeckBridge = {
  platform: string;
  selectDirectory(initialPath?: string): Promise<string | null>;
  /** 在系统文件管理器中打开绝对路径；浏览器调试环境没有该能力。 */
  openPath?(target: string): Promise<boolean>;
  chrome?: DesktopChrome;
  sessionLinks?: {
    onOpen(listener: (reference: string) => void): () => void;
    initial(): Promise<string | undefined>;
  };
};
