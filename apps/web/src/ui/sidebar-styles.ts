import { menuItemClass, popoverClass } from './styles';

export const sidebarMenuClass = `${popoverClass} min-w-48`;
export const sidebarMenuItemClass = `${menuItemClass} py-2`;
export const sidebarItemClass = (collapsed: boolean) =>
  `flex min-h-9 w-full min-w-0 items-center gap-3 rounded-lg text-left text-sm text-foreground transition-colors hover:bg-control-hover active:bg-control-active focus-visible:outline-interactive ${collapsed ? 'justify-center px-0' : 'px-3'}`;
