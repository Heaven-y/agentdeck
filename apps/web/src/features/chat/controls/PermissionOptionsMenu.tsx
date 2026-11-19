import { Menu, MenuButton, MenuItem, MenuProvider, MenuSeparator } from '@ariakit/react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { permissionChoices } from '../../../cli/permission-policies';
import { MenuChoice, modelMenuItemClass } from '../../../ui/fields/MenuChoice';
import { buttonClass } from '../../../ui/styles';
import { useChat } from '../state/chat-store';

export function PermissionOptionsMenu({ disabled }: { disabled: boolean }) {
  const agent = useChat((state) => state.agent);
  const selected = useChat((state) => state.permission);
  const choose = useChat((state) => state.setPermission);
  const pending = useChat((state) => state.permissionLoading || state.permissionSaving);
  const running = useChat((state) => state.running || !!state.pendingClientTurnId);
  disabled ||= pending || running;
  const choices = permissionChoices[agent];
  const current = choices.find((entry) => entry.selection.mode === selected?.mode);
  const label = current?.label ?? (pending ? '权限' : '原生默认');
  return (
    <MenuProvider placement="top-end">
      <MenuButton
        disabled={disabled}
        aria-label="权限模式"
        aria-busy={pending}
        title={label}
        className={`${buttonClass('ghost')} min-h-7 gap-1 rounded-lg px-2 text-[13px]`}
      >
        <ShieldCheck aria-hidden className="size-3.5" />
        <span>{label}</span>
        <ChevronDown aria-hidden className="size-3" />
      </MenuButton>
      <Menu
        portal
        unmountOnHide
        gutter={8}
        aria-label="权限模式菜单"
        className="z-50 max-h-[min(480px,var(--popover-available-height))] w-72 overflow-y-auto rounded-2xl border border-border bg-card p-1 text-foreground shadow-lg"
      >
        {choices.map((choice) => (
          <MenuChoice
            key={choice.selection.mode}
            checked={selected?.mode === choice.selection.mode}
            disabled={disabled}
            choose={() => choose(choice.selection)}
          >
            <span className="block" title={choice.description}>
              {choice.label}
            </span>
          </MenuChoice>
        ))}
        {current && (
          <>
            <MenuSeparator className="my-1 border-t border-border" />
            <MenuItem
              className={modelMenuItemClass}
              disabled={disabled}
              onClick={() => choose(agent === 'codex' ? { agent: 'codex', mode: 'native' } : undefined)}
            >
              重置权限
            </MenuItem>
          </>
        )}
      </Menu>
    </MenuProvider>
  );
}
