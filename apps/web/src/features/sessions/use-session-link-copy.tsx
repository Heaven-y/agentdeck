import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatSessionReference, type SessionRef } from '@agentdeck/shared/conversation';
import { inputClass } from '../../ui/styles';

/**
 * 复制会话引用。
 *
 * 成功时短暂浮动提示，不挤占列表；失败时保留手动复制输入框。
 * 后续操作和卸载会清理计时器，同时丢弃尚未完成的旧复制结果。
 */
export function useSessionLinkCopy(workspaceId: string) {
  const [notice, setNotice] = useState('');
  const [link, setLink] = useState('');
  const generation = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      generation.current++;
      clearTimeout(hideTimer.current);
    },
    [],
  );
  const clear = () => {
    generation.current++;
    clearTimeout(hideTimer.current);
    setNotice('');
    setLink('');
  };
  const copy = async (session: SessionRef) => {
    clear();
    const token = generation.current;
    const value = formatSessionReference({ workspaceId, agent: session.agent, sessionId: session.sessionId });
    try {
      await navigator.clipboard.writeText(value);
      if (token !== generation.current) return;
      setNotice('会话链接已复制');
      hideTimer.current = setTimeout(() => setNotice(''), 1500);
    } catch {
      if (token !== generation.current) return;
      setLink(value);
      setNotice('浏览器未允许写入剪贴板，请手动复制下方内容');
    }
  };
  return { notice, link, clear, copy };
}

/** 成功提示挂到页面浮层，不占列表空间，也不接收焦点或鼠标事件。 */
export function SessionLinkNotice({ notice, link }: { notice: string; link: string }) {
  if (!notice) return null;
  if (!link)
    return createPortal(
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed bottom-6 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-border-strong bg-card px-3 py-2 text-sm text-foreground shadow-lg"
      >
        {notice}
      </div>,
      document.body,
    );
  return (
    <div className="w-full min-w-0 px-4 text-xs leading-5 text-muted-foreground">
      <p role="status">{notice}</p>
      <label className="block py-2">
        手动复制会话引用
        <input
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
          className={`${inputClass} mt-1`}
        />
      </label>
    </div>
  );
}
