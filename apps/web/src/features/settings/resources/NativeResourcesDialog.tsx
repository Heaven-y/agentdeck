import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativeManagementContext, NativeResourceCatalog as Catalog } from '@agentdeck/shared/settings';
import { SettingsDetailDialog } from '../navigation/SettingsDetailDialog';
import { NativeResourceCatalog, type NativeResourceSelection } from './NativeResourceCatalog';
import { AGENT_FULL_NAMES } from '../../../cli/shared/labels';
import { nativeSettingsError } from './native-resource-labels';
import { invalidateNativeCapabilities } from '../../../cli/shared/capability-cache';
import { useGuardedSettingsNavigation } from '../navigation/settings-navigation';
import { settingsApi } from '../api';
import { ResourceFilter, ResourceFilters } from './ResourceList';

const NativeResourceEditor = lazy(() => import('./NativeResourceEditor'));
const NativeResourceCreate = lazy(() => import('./NativeResourceCreate'));
const NativeSkillsPanel = lazy(() => import('../skills/NativeSkillsPanel'));
const NativeMcpPanel = lazy(() => import('../mcp/NativeMcpPanel'));
const NativePluginsPanel = lazy(() => import('../plugins/NativePluginsPanel'));

export type NativeResourceCategory = 'all' | 'skills' | 'mcp' | 'plugins';
type ResourcesProps = {
  agent: AgentKind;
  category?: NativeResourceCategory;
  workspace?: { id: string; name: string };
  embedded?: boolean;
  onClose(): void;
  onBack(): void;
};

const SCOPED_CATEGORIES = new Set<NativeResourceCategory>(['skills', 'mcp', 'plugins']);

function ResourceScopeSwitch({
  workspace,
  selected,
  choose,
}: {
  workspace: { id: string; name: string };
  selected: boolean;
  choose(workspace: boolean): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <ResourceFilters label="配置范围">
        <ResourceFilter selected={!selected} onClick={() => choose(false)}>
          全局
        </ResourceFilter>
        <ResourceFilter selected={selected} onClick={() => choose(true)}>
          工作区
        </ResourceFilter>
      </ResourceFilters>
      {selected && (
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={workspace.name}>
          {workspace.name}
        </span>
      )}
    </div>
  );
}

export default function NativeResourcesDialog({ workspace, ...props }: ResourcesProps) {
  const leave = useGuardedSettingsNavigation();
  const [selected, select] = useState<string>();
  const scoped = props.category !== undefined && SCOPED_CATEGORIES.has(props.category) ? workspace : undefined;
  const projectId = scoped?.id === selected ? selected : undefined;
  const tabs = scoped ? (
    <ResourceScopeSwitch
      workspace={scoped}
      selected={projectId !== undefined}
      choose={(active) => {
        if (active !== Boolean(projectId)) leave(() => select(active ? scoped.id : undefined));
      }}
    />
  ) : undefined;
  return (
    <NativeResourcesContent
      key={JSON.stringify([props.agent, props.category])}
      {...props}
      projectId={projectId}
      tabs={tabs}
    />
  );
}

function NativeResourcesContent({
  agent,
  projectId,
  onClose,
  onBack,
  category = 'all',
  embedded = false,
  tabs,
}: ResourcesProps & { projectId?: string; tabs?: React.ReactNode }) {
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<{ projectId?: string; target: NativeResourceSelection }>();
  const target = selection?.projectId === projectId ? selection?.target : undefined;
  const select = (next: NativeResourceSelection) => setSelection({ projectId, target: next });
  const context = { agent, projectId };
  const refresh = () => setReload((value) => value + 1);
  const onChanged = () => {
    void invalidateNativeCapabilities(agent);
    refresh();
  };
  const returnToCatalog = () => setSelection(undefined);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (embedded && !target) heading.current?.focus();
  }, [embedded, target]);
  const title = { skills: 'Skills', mcp: 'MCP', plugins: '原生插件', all: '原生文件' }[category];
  if (target)
    return (
      <Suspense fallback={<p role="status">正在打开文件编辑器…</p>}>
        {'resource' in target ? (
          <NativeResourceEditor
            context={context}
            resource={target.resource}
            embedded={embedded}
            onBack={returnToCatalog}
            onClose={onClose}
          />
        ) : (
          <NativeResourceCreate
            context={context}
            root={target.root}
            embedded={embedded}
            onBack={returnToCatalog}
            onClose={onClose}
          />
        )}
      </Suspense>
    );
  const content = (
    <Suspense fallback={<p role="status">正在打开目录…</p>}>
      <NativeCatalogPanel
        key={projectId}
        category={category}
        context={context}
        reload={reload}
        onChanged={onChanged}
        select={select}
      />
    </Suspense>
  );
  if (embedded)
    return (
      <section aria-labelledby={headingId} className="min-w-0 space-y-4 pb-4">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <h2 id={headingId} ref={heading} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none">
            {title}
          </h2>
          {tabs}
        </header>
        {content}
      </section>
    );
  return (
    <SettingsDetailDialog title={`${title} · ${AGENT_FULL_NAMES[agent]}`} onBack={onBack} onClose={onClose}>
      {tabs}
      {content}
    </SettingsDetailDialog>
  );
}

function NativeCatalogPanel({
  category,
  context,
  reload,
  onChanged,
  select,
}: {
  category: NativeResourceCategory;
  context: NativeManagementContext;
  reload: number;
  onChanged(): void;
  select(target: NativeResourceSelection): void;
}) {
  switch (category) {
    case 'skills':
      return (
        <NativeSkillsPanel
          context={context}
          reload={reload}
          onChanged={onChanged}
          onEdit={(id, label, displayPath) => select({ resource: { id, label, displayPath } })}
          onCreate={(root) => select({ root })}
        />
      );
    case 'mcp':
      return <NativeMcpPanel context={context} reload={reload} onChanged={onChanged} />;
    case 'plugins':
      return <NativePluginsPanel context={context} reload={reload} onChanged={onChanged} />;
    default:
      return <NativeFiles agent={context.agent} select={select} />;
  }
}

function NativeFiles({
  agent,
  select,
}: {
  agent: NativeManagementContext['agent'];
  select(target: NativeResourceSelection): void;
}) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void settingsApi
      .listNativeResources({ agent }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setCatalog(value);
        setError('');
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(nativeSettingsError(reason));
      });
    return () => controller.abort();
  }, [agent, reload]);
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}{' '}
          <button type="button" className="underline" onClick={() => setReload((n) => n + 1)}>
            重试
          </button>
        </p>
      )}
      {catalog ? (
        <NativeResourceCatalog catalog={catalog} select={select} />
      ) : (
        !error && (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            正在读取原生资源目录…
          </p>
        )
      )}
    </>
  );
}
