import { useEffect, useState } from 'react';
import { useMinWidth } from '../layout/use-min-width';
import { useUiPreferences } from '../../ui/appearance/ui-preferences';
import { useChat } from '../../features/chat/state/chat-store';
import { useFilePreview } from '../../features/chat/files/file-preview-store';

/** 每次启动默认关闭；旧服务器栏的持久展开偏好不再决定对话界面。 */
export function useConversationSidebar() {
  const [open, setOpen] = useState(false);
  const wide = useMinWidth(1024);
  const collapsed = useUiPreferences((state) => state.sidebarCollapsed || state.sidebarAutoCollapsed);
  const visible = open && (wide || collapsed);
  useEffect(
    () =>
      useChat.subscribe((state, previous) => {
        if (!state.inspectedItemId || state.inspectorRequest === previous.inspectorRequest) return;
        useFilePreview.getState().close();
        if (!wide) useUiPreferences.getState().setSidebarAutoCollapsed(true);
        setOpen(true);
      }),
    [wide],
  );
  useEffect(
    () =>
      useFilePreview.subscribe((state, previous) => {
        if (!state.target || state.target === previous.target) return;
        if (!wide) useUiPreferences.getState().setSidebarAutoCollapsed(true);
        setOpen(true);
      }),
    [wide],
  );
  return {
    open: visible,
    hide: () => {
      setOpen(false);
      useFilePreview.getState().close();
      useChat.getState().inspectItem();
    },
    toggle: () => {
      if (!visible && !wide) useUiPreferences.getState().setSidebarAutoCollapsed(true);
      if (visible) useChat.getState().inspectItem();
      if (visible) useFilePreview.getState().close();
      setOpen(!visible);
    },
  };
}
