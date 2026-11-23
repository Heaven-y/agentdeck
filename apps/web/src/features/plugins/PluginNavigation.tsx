import { Blocks, Puzzle, SquareTerminal } from 'lucide-react';
import { pluginPages, type WorkbenchPlugin, type WorkbenchPluginPageContribution } from '@agentdeck/shared/plugins';
import { useUiPreferences } from '../../ui/appearance/ui-preferences';
import { sidebarItemClass } from '../../ui/sidebar-styles';

export function PluginNavigation({
  plugins,
  selected,
  selectedPage,
  open,
  manage,
}: {
  plugins: WorkbenchPlugin[];
  selected?: string;
  selectedPage?: WorkbenchPluginPageContribution;
  open(id?: string, page?: string): void;
  manage(): void;
}) {
  const collapsed = useUiPreferences((state) => state.sidebarCollapsed || state.sidebarAutoCollapsed);
  const visible = plugins.filter((plugin) => plugin.enabled);
  return (
    <section aria-label="工作台页面" className="space-y-0.5">
      <button type="button" aria-label="插件" title="插件" onClick={manage} className={sidebarItemClass(collapsed)}>
        <Blocks aria-hidden className="size-4 shrink-0" />
        {!collapsed && <span>插件</span>}
      </button>
      {visible.flatMap(({ manifest }) =>
        pluginPages(manifest)
          .filter((page) => page.location === 'sidebar')
          .map((page) => {
            const Icon = manifest.icon === 'terminal' ? SquareTerminal : Puzzle;
            return (
              <button
                key={`${manifest.id}:${page.id}`}
                type="button"
                aria-label={page.title}
                title={page.title}
                aria-current={
                  selected === manifest.id && (!selectedPage || selectedPage.id === page.id) ? 'page' : undefined
                }
                onClick={() => open(manifest.id, page.id)}
                className={`${sidebarItemClass(collapsed)} aria-[current]:bg-surface-selected aria-[current]:font-medium aria-[current]:text-interactive`}
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                {!collapsed && <span className="truncate">{page.title}</span>}
              </button>
            );
          }),
      )}
    </section>
  );
}
