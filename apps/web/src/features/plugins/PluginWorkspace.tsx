import { lazy, Suspense, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { WorkbenchPlugin, WorkbenchPluginPageContribution } from '@agentdeck/shared/plugins';
import type { PluginInvocation } from './use-plugin-pages';
import type { Workspace } from '@agentdeck/shared/projects';
import { buttonClass } from '../../ui/styles';
import { PluginErrorBoundary } from './PluginErrorBoundary';

const PluginFrame = lazy(() => import('./PluginFrame'));
function PluginPage({
  plugin,
  visible,
  close,
  children,
  page,
}: {
  plugin: WorkbenchPlugin;
  visible: boolean;
  close(): void;
  children: ReactNode;
  page?: WorkbenchPluginPageContribution;
}) {
  return (
    <section
      aria-label={`${plugin.manifest.name}页面`}
      hidden={!visible}
      inert={!visible}
      className={visible ? 'flex h-full min-h-0 flex-col' : 'hidden'}
    >
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <h1 className="text-sm font-semibold">{page?.title ?? plugin.manifest.name}</h1>
        <button
          type="button"
          aria-label={`关闭${plugin.manifest.name}页面`}
          className={buttonClass('ghost')}
          onClick={close}
        >
          <X aria-hidden className="size-4" />
          {page?.location === 'settings' ? '返回设置' : '返回对话'}
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
  page,
  invocations = {},
  delivered,
  hidden = false,
}: {
  plugin?: WorkbenchPlugin;
  enabledPlugins: WorkbenchPlugin[];
  project?: Workspace;
  close(): void;
  page?: WorkbenchPluginPageContribution;
  invocations?: Record<string, PluginInvocation[]>;
  delivered?(pluginId: string, sequence: number): void;
  hidden?: boolean;
}) {
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  const activeId = plugin?.manifest.id;
  const requested = enabled.filter((entry) => invocations[entry.manifest.id]?.length);
  const nextVisited = new Set(
    [...visited, ...requested.map((entry) => entry.manifest.id), ...(activeId ? [activeId] : [])].filter((id) =>
      enabled.some((entry) => entry.manifest.id === id),
    ),
  );
  if (nextVisited.size !== visited.size || [...nextVisited].some((id) => !visited.has(id))) setVisited(nextVisited);
  return (
    <>
      {enabled
        .filter((entry) =>
          entry.manifest.apiVersion === 2
            ? visited.has(entry.manifest.id) ||
              !!entry.manifest.events?.length ||
              !!invocations[entry.manifest.id]?.length
            : entry.manifest.id === activeId,
        )
        .map((entry) => {
          const visible = !hidden && activeId === entry.manifest.id;
          return (
            <PluginPage key={entry.manifest.id} plugin={entry} visible={visible} close={close} page={page}>
              <PluginFrame
                plugin={entry}
                visible={visible}
                project={project}
                page={activeId === entry.manifest.id ? page : undefined}
                invocations={invocations[entry.manifest.id]}
                delivered={(sequence) => delivered?.(entry.manifest.id, sequence)}
              />
            </PluginPage>
          );
        })}
    </>
  );
}
