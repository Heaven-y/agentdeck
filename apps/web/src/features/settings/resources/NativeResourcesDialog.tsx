import { lazy, Suspense, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativeManagementContext, NativeResourceCatalog as Catalog } from '@agentdeck/shared/settings';
import { buttonClass } from '../../../ui/styles';
import { SettingsDetailDialog } from '../navigation/SettingsDetailDialog';
import { NativeResourceCatalog, type NativeResourceSelection } from './NativeResourceCatalog';
import { AGENT_FULL_NAMES } from '../../../cli/shared/labels';
import { nativeSettingsError } from './native-resource-labels';
import { invalidateNativeCapabilities } from '../../../cli/shared/capability-cache';
import { useGuardedSettingsNavigation } from '../navigation/settings-navigation';
import { settingsApi } from '../api';

const NativeResourceEditor = lazy(() => import('./NativeResourceEditor'));
const NativeResourceCreate = lazy(() => import('./NativeResourceCreate'));
const NativeSkillsPanel = lazy(() => import('../skills/NativeSkillsPanel'));
const NativeMcpPanel = lazy(() => import('../mcp/NativeMcpPanel'));
const NativePluginsPanel = lazy(() => import('../plugins/NativePluginsPanel'));

export type NativeResourceCategory = 'all' | 'skills' | 'mcp' | 'plugins' | 'custom';
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
    <nav aria-label="配置范围" className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
      <button
        type="button"
        className={buttonClass(!selected ? 'primary' : 'ghost')}
        aria-pressed={!selected}
        onClick={() => choose(false)}
      >
        全局
      </button>
      <button
        type="button"
        className={buttonClass(selected ? 'primary' : 'ghost')}
        aria-pressed={selected}
        onClick={() => choose(true)}
      >
        工作区
      </button>
      {selected && (
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={workspace.name}>
          {workspace.name}
        </span>
      )}
    </nav>
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
      key={JSON.stringify([props.agent, props.category, projectId])}
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
  const [target, select] = useState<NativeResourceSelection>();
  const context = { agent, projectId };
  const refresh = () => setReload((value) => value + 1);
  const onChanged = () => {
    void invalidateNativeCapabilities(agent);
    refresh();
  };
  const returnToCatalog = () => {
    select(undefined);
  };
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
  return (
    <SettingsDetailDialog
      title={`原生配置与扩展 · ${AGENT_FULL_NAMES[agent]}`}
      embedded={embedded}
      showBack={!embedded}
      onBack={onBack}
      onClose={onClose}
    >
      {category !== 'all' && category !== 'custom' && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">{tabs}</div>
          <details className="relative shrink-0">
            <summary className="cursor-pointer text-sm text-muted-foreground">更多操作</summary>
            <button
              type="button"
              className={buttonClass('outline')}
              onClick={(event) => {
                event.currentTarget.closest('details')?.removeAttribute('open');
                refresh();
              }}
            >
              重新读取目录
            </button>
          </details>
        </div>
      )}
      <Suspense fallback={<p role="status">正在打开目录…</p>}>
        {category === 'skills' ? (
          <NativeSkillsPanel
            context={context}
            reload={reload}
            onChanged={onChanged}
            onEdit={(id, label, displayPath) => select({ resource: { id, label, displayPath } })}
            onCreate={(root) => select({ root })}
          />
        ) : category === 'mcp' ? (
          <NativeMcpPanel context={context} reload={reload} onChanged={onChanged} />
        ) : category === 'plugins' ? (
          <NativePluginsPanel context={context} reload={reload} onChanged={onChanged} />
        ) : (
          <NativeFiles agent={agent} category={category} select={select} />
        )}
      </Suspense>
    </SettingsDetailDialog>
  );
}

function NativeFiles({
  agent,
  category,
  select,
}: {
  agent: NativeManagementContext['agent'];
  category: 'all' | 'custom';
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
      <button
        type="button"
        className={buttonClass('outline')}
        disabled={!catalog && !error}
        onClick={() => setReload((n) => n + 1)}
      >
        <RefreshCw aria-hidden className="size-4" />
        刷新目录
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      {catalog ? (
        <NativeResourceCatalog
          catalog={
            category === 'all'
              ? catalog
              : {
                  ...catalog,
                  entries: catalog.entries.filter((entry) => ['rules', 'hooks', 'agents'].includes(entry.kind)),
                  roots: catalog.roots.filter((root) => root.kind !== 'skills'),
                }
          }
          select={select}
        />
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
