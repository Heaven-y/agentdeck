import { useRef, useState, type ReactNode } from 'react';
import { leaveSettings } from '../../features/settings/navigation/settings-navigation';
import type { SettingsLeave } from '../../features/settings/navigation/settings-navigation';

/** 设置独占工作区域，保留工作台树中的会话草稿、插件与后台订阅。 */
export function SettingsWorkspace({
  opened,
  settings,
  children,
}: {
  opened: boolean;
  settings: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div hidden={opened} inert={opened} className={opened ? 'hidden' : 'flex min-h-0 flex-1'}>
        {children}
      </div>
      {opened && <div className="flex min-h-0 flex-1 flex-col">{settings}</div>}
    </>
  );
}

/** 页面内返回已经过编辑器保护；外部导航把完整动作交给当前保护执行。 */
export function useSettingsWorkspace(conversationSelected = true) {
  const [opened, setOpened] = useState(false);
  const guardRef = useRef<SettingsLeave>(leaveSettings);
  const trigger = useRef<HTMLElement | null>(null);
  const open = () => {
    if (opened) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpened(true);
  };
  const close = () => {
    setOpened(false);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
    });
  };
  const navigate = (action: () => boolean | void) => {
    let accepted = false;
    const leave = () => {
      if (action() === false) return;
      setOpened(false);
      accepted = true;
    };
    if (opened) guardRef.current(leave);
    else leave();
    return accepted;
  };
  return { opened, open, close, navigate, guardRef, conversationVisible: !opened && conversationSelected };
}
