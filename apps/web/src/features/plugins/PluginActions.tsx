import { Menu, MenuButton, MenuItem, MenuProvider } from '@ariakit/react';
import { Puzzle } from 'lucide-react';
import { pluginActions, pluginPages } from '@agentdeck/shared/plugins';
import { buttonClass, menuItemClass, popoverClass } from '../../ui/styles';
import { usePluginHost } from './plugin-host';

/** 声明的命令集中在一个入口，未安装扩展时不占据输入区。 */
export function PluginActions({ disabled = false }: { disabled?: boolean }) {
  const host = usePluginHost();
  const actions =
    host?.plugins
      .filter((plugin) => plugin.enabled)
      .flatMap((plugin) =>
        pluginActions(plugin.manifest).flatMap((action) => {
          const command = plugin.manifest.commands.find((command) => command.id === action.command);
          return command ? [{ plugin, command, location: action.location }] : [];
        }),
      ) ?? [];
  if (!actions.length) return null;
  const entries = [
    ...new Map(actions.map((action) => [`${action.plugin.manifest.id}:${action.command.id}`, action])).values(),
  ];
  const title = '扩展操作';
  return (
    <MenuProvider placement="top-start">
      <MenuButton disabled={disabled} className={buttonClass('ghost')} aria-label={title} title={title}>
        <Puzzle aria-hidden className="size-4" />
      </MenuButton>
      <Menu
        portal
        unmountOnHide
        gutter={8}
        aria-label={title}
        className={`${popoverClass} max-h-[min(480px,var(--popover-available-height))] min-w-60 max-w-96 overflow-y-auto`}
      >
        {entries.map(({ plugin, command }) => (
          <MenuItem
            key={`${plugin.manifest.id}:${command.id}`}
            className={`${menuItemClass} justify-between gap-6`}
            onClick={() => host?.run(plugin, command.id)}
          >
            <span>{command.title}</span>
            <span className="text-xs text-muted-foreground">{plugin.manifest.name}</span>
          </MenuItem>
        ))}
      </Menu>
    </MenuProvider>
  );
}

export function PluginSettingsNavigation() {
  const host = usePluginHost();
  const entries =
    host?.plugins
      .filter((plugin) => plugin.enabled)
      .flatMap((plugin) =>
        pluginPages(plugin.manifest)
          .filter((page) => page.location === 'settings')
          .map((page) => ({ plugin, page })),
      ) ?? [];
  if (!entries.length) return null;
  return (
    <div className="mt-3 space-y-1 border-t border-border pt-3" aria-label="扩展设置">
      {entries.map(({ plugin, page }) => (
        <button
          key={`${plugin.manifest.id}:${page.id}`}
          type="button"
          className="settings-navigation-item flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-control-hover"
          onClick={() => host?.open(plugin, page)}
        >
          <Puzzle aria-hidden className="size-4 shrink-0" />
          <span>{page.title}</span>
        </button>
      ))}
    </div>
  );
}
