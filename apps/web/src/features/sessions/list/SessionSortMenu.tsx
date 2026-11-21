import { Menu, MenuButton, MenuProvider } from '@ariakit/react';
import { ArrowDownWideNarrow } from 'lucide-react';
import { MenuChoice } from '../../../ui/fields/MenuChoice';
import { iconButtonClass, popoverClass } from '../../../ui/styles';
import { useSessionOrder } from './session-order';

export function SessionSortMenu() {
  const mode = useSessionOrder((state) => state.mode);
  const choose = useSessionOrder((state) => state.setMode);
  return (
    <MenuProvider placement="bottom-end">
      <MenuButton aria-label="会话排序" title="会话排序" className={iconButtonClass}>
        <ArrowDownWideNarrow aria-hidden className="size-3.5" />
      </MenuButton>
      <Menu portal unmountOnHide gutter={6} aria-label="会话排序方式" className={`${popoverClass} min-w-40`}>
        {(
          [
            ['recent', '最近活动'],
            ['name', '名称'],
            ['manual', '手动顺序'],
          ] as const
        ).map(([value, label]) => (
          <MenuChoice key={value} checked={mode === value} choose={() => choose(value)}>
            {label}
          </MenuChoice>
        ))}
        <p className="mt-1 w-48 border-t border-border px-2 pt-2 pb-1 text-xs leading-5 text-muted-foreground">
          任意排序下均可拖动，或用 Alt+↑/↓ 调整。
        </p>
      </Menu>
    </MenuProvider>
  );
}
