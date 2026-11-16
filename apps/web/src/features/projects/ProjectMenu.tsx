import { Menu, MenuButton, MenuItem, useMenuStore } from '@ariakit/react';
import { FolderOpen, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useRef } from 'react';
import type { Workspace } from '@agentdeck/shared/projects';
import { buttonClass } from '../../ui/styles';
import { useProjectChatBusy, type ProjectManageAction } from './project-management';

const actions = [
  { action: 'rename', label: '重命名项目', Icon: Pencil },
  { action: 'directory', label: '更换项目目录', Icon: FolderOpen },
  { action: 'remove', label: '移除项目', Icon: Trash2 },
] as const;
export function ProjectMenu({
  project,
  running,
  choose,
  reveal,
}: {
  project: Workspace;
  running: boolean;
  choose?(action: ProjectManageAction): void;
  /** 只有桌面壳提供打开路径能力时才显示该入口。 */
  reveal?: { label: string; open(): void };
}) {
  const busy = useProjectChatBusy(project.id);
  const disabled = busy || running;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useMenuStore({ placement: 'bottom-start' });
  return (
    <>
      <MenuButton
        store={menu}
        ref={trigger}
        render={<button type="button" />}
        aria-label={`管理项目“${project.name}”`}
        title={disabled ? '会话运行或操作中，结束后可管理项目' : '项目管理'}
        className={`${buttonClass('ghost')} mr-1 shrink-0 px-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 aria-expanded:opacity-100`}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </MenuButton>
      <Menu
        store={menu}
        portal
        unmountOnHide
        gutter={6}
        aria-label="项目操作"
        className="z-50 min-w-40 rounded-xl border border-border-strong bg-card p-1.5 text-foreground shadow-xl"
      >
        <p className="max-w-64 px-3 py-2 font-mono text-[11px] break-all text-muted-foreground">{project.dir}</p>
        {disabled && (
          <p className="max-w-64 px-3 pb-2 text-xs text-muted-foreground">会话运行或操作中，结束后可修改项目。</p>
        )}
        {reveal && (
          <MenuItem
            className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-active-item:bg-muted data-active-item:ring-1 data-active-item:ring-accent"
            onClick={() => {
              menu.hide();
              trigger.current?.focus();
              reveal.open();
            }}
          >
            <FolderOpen aria-hidden className="size-4" />
            {reveal.label}
          </MenuItem>
        )}
        {choose &&
          actions.map(({ action, label, Icon }) => (
            <MenuItem
              key={action}
              disabled={disabled}
              className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-active-item:bg-muted data-active-item:ring-1 data-active-item:ring-accent ${action === 'remove' ? 'text-destructive-foreground' : ''}`}
              onClick={() => {
                menu.hide();
                trigger.current?.focus();
                choose(action);
              }}
            >
              <Icon aria-hidden className="size-4" />
              {label}
            </MenuItem>
          ))}
      </Menu>
    </>
  );
}
