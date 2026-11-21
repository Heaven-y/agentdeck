import { MenuItem } from '@ariakit/react';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { menuItemClass } from '../styles';

export const modelMenuItemClass = menuItemClass;
export function MenuChoice({
  checked,
  disabled,
  choose,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  choose(): void;
  children: ReactNode;
}) {
  return (
    <MenuItem
      role="menuitemradio"
      aria-checked={checked}
      disabled={disabled}
      onClick={choose}
      className={modelMenuItemClass}
    >
      <Check aria-hidden className={`size-3.5 shrink-0 ${checked ? '' : 'invisible'}`} />
      <span className="min-w-0 flex-1">{children}</span>
    </MenuItem>
  );
}
