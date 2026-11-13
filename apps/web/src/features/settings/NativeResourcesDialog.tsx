import { settingsApi } from './api';

import { lazy, Suspense, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativeResourceCatalog as Catalog } from '@agentdeck/shared/settings';
import type { Workspace } from '@agentdeck/shared/projects';

import { buttonClass } from '../../ui/styles';
import { SettingsDetailDialog } from './SettingsDetailDialog';
import { NativeResourceCatalog, type NativeResourceSelection } from './NativeResourceCatalog';
import { nativeAgentNames, nativeSettingsError } from './native-resource-labels';
import { invalidateNativeCapabilities } from '../../cli/shared/capability-cache';
import { useGuardedSettingsNavigation } from './settings-navigation';

const NativeResourceEditor = lazy(() => import('./NativeResourceEditor'));
const NativeResourceCreate = lazy(() => import('./NativeResourceCreate'));
const NativeSkillsPanel = lazy(() => import('./NativeSkillsPanel'));
const NativeMcpPanel = lazy(() => import('./NativeMcpPanel'));
const NativePluginsPanel = lazy(() => import('./NativePluginsPanel'));

export type NativeResourceCategory = 'all' | 'skills' | 'mcp' | 'plugins' | 'custom';
type ResourcesProps = {
  agent: AgentKind;
  project?: Workspace;
  category?: NativeResourceCategory;
  embedded?: boolean;
  onClose(): void;
  onBack(): void;
};

export default function NativeResourcesDialog(props: ResourcesProps) {
  return <NativeResourcesContent key={JSON.stringify([props.agent, props.project?.id, props.category])} {...props} />;
}

function NativeResourcesContent({
  agent,
  project,
  onClose,
  onBack,
  category: controlledCategory,
  embedded = false,
}: ResourcesProps) {
  const projectId = project?.id;
  const leave = useGuardedSettingsNavigation();
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState<NativeResourceSelection>();
  const [localCategory, setCategory] = useState<NativeResourceCategory>('all');
  const category = controlledCategory ?? localCategory;
  useEffect(() => {
    const controller = new AbortController();
    void settingsApi
      .listNativeResources({ agent, projectId }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setCatalog(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(nativeSettingsError(reason));
      });
    return () => controller.abort();
  }, [agent, projectId, reload]);
  const refresh = () => {
    setCatalog(undefined);
    setError('');
    setReload((value) => value + 1);
  };
  const returnToCatalog = () => {
    setTarget(undefined);
    refresh();
  };
  if (target)
    return (
      <Suspense fallback={<p role="status">正在打开文件编辑器…</p>}>
        {'resource' in target ? (
          <NativeResourceEditor
            context={{ agent, projectId }}
            resource={target.resource}
            embedded={embedded}
            onBack={returnToCatalog}
            onClose={onClose}
          />
        ) : (
          <NativeResourceCreate
            context={{ agent, projectId }}
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
      title={`原生配置与扩展 · ${nativeAgentNames[agent]}`}
      embedded={embedded}
      showBack={!embedded}
      onBack={onBack}
      onClose={onClose}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ResourceProject project={project} />
        <button
          type="button"
          className={buttonClass('outline')}
          onClick={() => leave(refresh)}
          disabled={catalogLoading(catalog, error)}
        >
          <RefreshCw aria-hidden className="size-4" />
          刷新目录
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      {!embedded && <ResourceCategories category={category} select={setCategory} />}
      <ResourceCategoryContent
        agent={agent}
        projectId={projectId}
        catalog={catalog}
        category={category}
        error={error}
        reload={reload}
        select={setTarget}
        refresh={refresh}
        onChanged={() => {
          void invalidateNativeCapabilities(agent);
          setReload((value) => value + 1);
        }}
      />
    </SettingsDetailDialog>
  );
}

function ResourceCategoryContent({
  agent,
  projectId,
  catalog,
  category,
  error,
  reload,
  select,
  refresh,
  onChanged,
}: {
  agent: AgentKind;
  projectId?: string;
  catalog?: Catalog;
  category: NativeResourceCategory;
  error: string;
  reload: number;
  select(target: NativeResourceSelection): void;
  refresh(): void;
  onChanged(): void;
}) {
  return category === 'skills' ? (
    <Suspense fallback={<p role="status">正在打开 Skills 管理…</p>}>
      <NativeSkillsPanel
        key={JSON.stringify([agent, projectId])}
        context={{ agent, projectId }}
        reload={reload}
        onEdit={(id) => {
          const resource = catalog?.entries.find((entry) => entry.id === id);
          if (resource) select({ resource });
          else refresh();
        }}
        onCreate={(root) => select({ root })}
        onChanged={onChanged}
      />
    </Suspense>
  ) : category === 'mcp' ? (
    <Suspense fallback={<p role="status">正在打开 MCP 管理…</p>}>
      <NativeMcpPanel
        key={JSON.stringify([agent, projectId])}
        context={{ agent, projectId }}
        reload={reload}
        onChanged={onChanged}
      />
    </Suspense>
  ) : category === 'plugins' ? (
    <Suspense fallback={<p role="status">正在打开原生插件管理…</p>}>
      <NativePluginsPanel
        key={JSON.stringify([agent, projectId])}
        context={{ agent, projectId }}
        reload={reload}
        onChanged={onChanged}
      />
    </Suspense>
  ) : catalog ? (
    <NativeResourceCatalog catalog={filteredCatalog(catalog, category)} select={select} />
  ) : (
    !error && (
      <p role="status" className="py-8 text-center text-sm text-muted-foreground">
        正在读取原生资源目录…
      </p>
    )
  );
}

function ResourceCategories({
  category,
  select,
}: {
  category: NativeResourceCategory;
  select(category: NativeResourceCategory): void;
}) {
  const categories: Array<[NativeResourceCategory, string]> = [
    ['all', '全部原文'],
    ['skills', 'Skills'],
    ['mcp', 'MCP'],
    ['plugins', '原生插件'],
    ['custom', '规则 / Hooks / 代理定义'],
  ];
  return (
    <nav aria-label="原生资源分类" className="flex flex-wrap gap-2">
      {categories.map(([id, label]) => (
        <button
          type="button"
          className={buttonClass(category === id ? 'primary' : 'outline')}
          aria-pressed={category === id}
          key={id}
          onClick={() => select(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
const catalogLoading = (catalog: Catalog | undefined, error: string) => !catalog && !error;
function ResourceProject({ project }: { project?: Workspace }) {
  return (
    <div className="min-w-0 flex-1 space-y-1 text-sm text-muted-foreground">
      <p>{project ? `当前项目：${project.name}` : '尚未选择项目，显示当前可用的原生入口。'}</p>
      {project && <p className="break-all font-mono text-xs">{project.dir}</p>}
    </div>
  );
}

function filteredCatalog(catalog: Catalog, category: string): Catalog {
  if (category === 'all') return catalog;
  const custom = category === 'custom';
  return {
    ...catalog,
    entries: catalog.entries.filter((entry) =>
      custom ? ['rules', 'hooks', 'agents'].includes(entry.kind) : entry.kind === category,
    ),
    roots: catalog.roots.filter((root) => (custom ? root.kind !== 'skills' : root.kind === category)),
  };
}
