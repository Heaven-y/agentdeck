import { lazy, Suspense, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { WorkbenchPlugin } from '@agentdeck/shared/plugins';
import type { Workspace } from '@agentdeck/shared/projects';
import { buttonClass } from '../../ui/styles';
import { PluginErrorBoundary } from './PluginErrorBoundary';

const PluginFrame = lazy(() => import('./PluginFrame'));
function PluginPage({
  plugin,
  visible,
  close,
  children,
}: {
  plugin: WorkbenchPlugin;
  visible: boolean;
  close(): void;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={`${plugin.manifest.name}页面`}
      hidden={!visible}
      inert={!visible}
      className={visible ? 'flex h-full min-h-0 flex-col' : 'hidden'}
    >
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h1 className="text-sm font-semibold">{plugin.manifest.name}</h1>
        <button
          type="button"
          aria-label={`关闭${plugin.manifest.name}页面`}
          className={buttonClass('ghost')}
          onClick={close}
        >
          <X aria-hidden className="size-4" />
          返回对话
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <PluginErrorBoundary close={close}>
          <Suspense
            fallback={
              <p role="status" className="p-4 text-sm">
                正在打开插件页面…
              </p>
            }
          >
            {children}
          </Suspense>
        </PluginErrorBoundary>
      </div>
    </section>
  );
}

export function PluginWorkspace({
  plugin,
  enabledPlugins: enabled,
  project,
  close,
  command,
}: {
  plugin?: WorkbenchPlugin;
  enabledPlugins: WorkbenchPlugin[];
  project?: Workspace;
  close(): void;
  command?: { id: string; sequence: number };
}) {
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  const activeId = plugin?.manifest.id;
  if (activeId && !visited.has(activeId)) setVisited(new Set(visited).add(activeId));
  return (
    <>
      {enabled
        .filter((entry) =>
          entry.manifest.apiVersion === 2 ? visited.has(entry.manifest.id) : entry.manifest.id === activeId,
        )
        .map((entry) => {
          const visible = activeId === entry.manifest.id;
          return (
            <PluginPage key={entry.manifest.id} plugin={entry} visible={visible} close={close}>
              <PluginFrame plugin={entry} visible={visible} project={project} command={visible ? command : undefined} />
            </PluginPage>
          );
        })}
    </>
  );
}
