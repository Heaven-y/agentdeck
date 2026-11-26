import { Menu, MenuButton, MenuItem, useMenuStore } from '@ariakit/react';
import { Archive, ArchiveRestore, GitFork, Link, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import { type SessionActionInput, type SessionSummary, type SessionCapabilities } from '@agentdeck/shared/conversation';
import { buttonClass, menuItemClass, popoverClass } from '../../../ui/styles';
import { AGENT_LABELS } from '../../../cli/shared/labels';

export type SessionDialogAction = SessionActionInput['action'] | 'fork';
export type SessionMenuAction = SessionDialogAction | 'copy';
const actions = {
  rename: { label: '重命名', icon: Pencil },
  copy: { label: '复制会话链接', icon: Link },
  fork: { label: '创建分支', icon: GitFork },
  delete: { label: '删除', icon: Trash2 },
  archive: { label: '归档', icon: Archive },
  unarchive: { label: '恢复', icon: ArchiveRestore },
};

function visibleActions(capabilities: SessionCapabilities | undefined, archived: boolean): SessionMenuAction[] {
  const { rename, fork, archive, delete: remove } = capabilities ?? {};
  const visible: SessionMenuAction[] = [];
  if (!archived) {
    if (rename) visible.push('rename');
    if (fork) visible.push('fork');
  }
  visible.push('copy');
  if (archive) visible.push(archived ? 'unarchive' : 'archive');
  if (remove) visible.push('delete');
  return visible;
}

/** 菜单仅选动作；危险操作在后续确认视图中执行。 */
export function SessionMenu({
  session,
  archived,
  disabled,
  choose,
  hoverReveal = false,
}: {
  session: SessionSummary;
  archived: boolean;
  disabled: boolean;
  choose(action: SessionMenuAction): void;
  /** 在紧凑列表中默认低调隐藏，悬停、键盘聚焦或展开菜单时可见。 */
  hoverReveal?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useMenuStore({ placement: 'bottom-start' });
  const capabilities = session.capabilities;
  const visible = visibleActions(capabilities, archived);
  if (!visible.length) return null;
  const revealClass = hoverReveal
    ? 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus:opacity-100 aria-expanded:opacity-100'
    : '';
  return (
    <>
      <MenuButton
        ref={trigger}
        store={menu}
        render={<button type="button" />}
        className={`${buttonClass('ghost')} shrink-0 px-1.5 ${revealClass}`}
        aria-label={`${AGENT_LABELS[session.agent]} 会话“${session.title || '无标题会话'}”的更多操作`}
        title={disabled ? '会话运行或操作中，可复制会话引用' : '更多会话操作'}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </MenuButton>
      <Menu store={menu} portal unmountOnHide gutter={6} aria-label="会话操作" className={`${popoverClass} min-w-44`}>
        {visible.map((action) => {
          const Icon = actions[action].icon;
          return (
            <MenuItem
              key={action}
              disabled={disabled && action !== 'copy'}
              className={`${menuItemClass} py-2 ${action === 'delete' ? 'text-destructive-foreground' : ''}`}
              onClick={() => {
                menu.hide();
                // 对话框关闭后回到仍存在的更多按钮，而不是即将卸载的菜单项。
                trigger.current?.focus();
                choose(action);
              }}
            >
              <Icon aria-hidden className="size-4" />
              {actions[action].label}
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
