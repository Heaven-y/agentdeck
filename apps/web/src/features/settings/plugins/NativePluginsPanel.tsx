import { useEffect, useRef, useState } from 'react';
import { Plus, Puzzle } from 'lucide-react';
import type {
  NativeManagementContext,
  NativePluginCatalog,
  NativePluginEntry,
  NativePluginOperation as Operation,
  NativePluginPrepareInput,
  NativePluginAction,
} from '@agentdeck/shared/settings';
import { buttonClass } from '../../../ui/styles';
import { nativePluginsApi } from './native-plugins-api';
import { nativeSettingsError } from '../resources/native-resource-labels';
import { NativePluginOperation, pluginTaskActive, pluginScopeLabel } from './NativePluginOperation';
import { inNativeScope } from '../resources/native-resource-scope';
import { NativePluginInstall } from './NativePluginInstall';
import { NativePluginDetails } from './NativePluginDetails';
import {
  catalogListClass,
  ResourceDetails,
  ResourceEmpty,
  ResourceRow,
  useResourceReturnFocus,
} from '../resources/ResourceList';
type DetailSelection = { entry: NativePluginEntry; operationId?: string };
const visibleDetail = (detail: DetailSelection | undefined, configuration?: Operation) =>
  configuration?.status === 'succeeded' ? undefined : detail?.entry;
const previewPending = (configuration?: Operation) => configuration?.status === 'prepared';
const labels: Partial<Record<NativePluginAction, string>> = {
  enable: '启用',
  disable: '禁用',
  uninstall: '卸载',
  update: '更新',
  validate: '验证',
  'marketplace-remove': '移除来源',
  'marketplace-refresh': '刷新来源',
};
function PluginActions({
  entry,
  busy,
  onPrepare,
}: {
  entry: NativePluginEntry;
  busy: boolean;
  onPrepare(input: NativePluginPrepareInput): void;
}) {
  const available = entry.actions.filter(
    (action) =>
      !['configure', 'install'].includes(action) &&
      !(action === 'enable' && entry.enabled === true) &&
      !(action === 'disable' && entry.enabled === false),
  );
  if (!available.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {available.map((action) => (
        <button
          type="button"
          key={action}
          disabled={busy}
          className={buttonClass(action === 'uninstall' ? 'danger' : 'outline')}
          onClick={() => onPrepare({ action, id: entry.id, revision: entry.revision })}
        >
          {labels[action]}
        </button>
      ))}
    </div>
  );
}
type PluginFailure = { source: 'catalog' | 'operation' | 'progress'; message: string };

function PluginFailureMessage({ failure, retry }: { failure?: PluginFailure; retry(): void }) {
  if (!failure) return null;
  return (
    <p role="alert" className="text-sm text-destructive-foreground">
      {failure.message}{' '}
      {failure.source === 'catalog' && (
        <button type="button" className="underline" onClick={retry}>
          重试
        </button>
      )}
    </p>
  );
}

function PluginList({
  catalog,
  locked,
  onDetail,
  onView,
}: {
  catalog: NativePluginCatalog;
  locked: boolean;
  onDetail(entry: NativePluginEntry, trigger: HTMLButtonElement): void;
  onView(view: 'install' | 'markets', trigger: HTMLButtonElement): void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{catalog.entries.length} 个已安装插件</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {catalog.marketplaces.length > 0 && (
            <button
              type="button"
              className={buttonClass('ghost')}
              onClick={(event) => onView('markets', event.currentTarget)}
            >
              市场来源
            </button>
          )}
          {catalog.installScopes.length > 0 && (catalog.canInstall || catalog.canAddMarketplace) && (
            <button
              type="button"
              className={buttonClass('primary')}
              disabled={locked}
              onClick={(event) => onView('install', event.currentTarget)}
            >
              <Plus aria-hidden className="size-4" />
              {catalog.canInstall ? '添加插件' : '添加市场来源'}
            </button>
          )}
        </div>
      </div>
      {catalog.entries.length ? (
        <ul className={catalogListClass}>
          {catalog.entries.map((entry) => (
            <ResourceRow
              key={entry.id}
              name={entry.name}
              description={entry.description || (entry.version ? `版本 ${entry.version}` : undefined)}
              icon={Puzzle}
              status={entry.enabled === null ? undefined : entry.enabled ? '已启用' : '已禁用'}
              onOpen={(button) => onDetail(entry, button)}
            />
          ))}
        </ul>
      ) : (
        <ResourceEmpty>暂无已安装插件。</ResourceEmpty>
      )}
    </div>
  );
}

export default function NativePluginsPanel({
  context,
  reload,
  onChanged,
}: {
  context: NativeManagementContext;
  reload: number;
  onChanged(): void;
}) {
  const { agent, projectId } = context;
  const [catalog, setCatalog] = useState<NativePluginCatalog>();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [failure, setFailure] = useState<PluginFailure>();
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<DetailSelection>();
  const [view, setView] = useState<'install' | 'markets'>();
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void nativePluginsApi
      .read({ agent, projectId }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setCatalog(value);
          setOperations(value.operations);
          setFailure((previous) => (previous?.source === 'catalog' ? undefined : previous));
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setFailure({ source: 'catalog', message: nativeSettingsError(reason) });
      });
    return () => controller.abort();
  }, [agent, projectId, reload, refresh]);
  const activeIds = operations
    .filter((op) => pluginTaskActive(op.status))
    .map((op) => op.operationId)
    .join(',');
  useEffect(() => {
    if (!activeIds) return;
    let current = true,
      polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void Promise.all(activeIds.split(',').map((id) => nativePluginsApi.operation({ agent, projectId }, id)))
        .then((values) => {
          if (!current) return;
          setFailure((previous) => (previous?.source === 'progress' ? undefined : previous));
          setOperations((previous) =>
            previous.map((op) => values.find((value) => value.operationId === op.operationId) ?? op),
          );
          if (values.some((op) => !pluginTaskActive(op.status))) {
            changed.current();
          }
        })
        .catch(() => {
          if (current)
            setFailure((previous) => previous ?? { source: 'progress', message: '暂时读不到插件操作进度，正在重试。' });
        })
        .finally(() => {
          polling = false;
        });
    }, 1000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [agent, projectId, activeIds]);
  const saveOperation = (operation: Operation) =>
    setOperations((previous) => [operation, ...previous.filter((op) => op.operationId !== operation.operationId)]);
  const acceptOperation = (result: Operation, configurationId?: string) => {
    if (!mounted.current) return;
    saveOperation(result);
    if (configurationId)
      setDetail((current) =>
        current && current.entry.id === configurationId ? { ...current, operationId: result.operationId } : current,
      );
    if (!pluginTaskActive(result.status) && result.status !== 'prepared') {
      changed.current();
    }
  };
  const syncOperation = async (operationId?: string) => {
    if (!operationId) return;
    try {
      const latest = await nativePluginsApi.operation(context, operationId);
      if (mounted.current) saveOperation(latest);
    } catch {
      /* 保留原始错误，已有任务仍可继续轮询。 */
    }
  };
  const run = async (
    action: () => Promise<Operation>,
    target: { configurationId?: string; operationId?: string } = {},
  ) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const operation = await action();
      acceptOperation(operation, target.configurationId);
      return operation;
    } catch (reason) {
      await syncOperation(target.operationId);
      if (mounted.current) setFailure({ source: 'operation', message: nativeSettingsError(reason) });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const prepare = (input: NativePluginPrepareInput) =>
    run(() => nativePluginsApi.prepare(context, input), {
      configurationId: input.action === 'configure' ? input.id : undefined,
    });
  const locked = busy || !!activeIds;
  const configuration = operations.find((operation) => operation.operationId === detail?.operationId);
  const visibleEntry = visibleDetail(detail, configuration);
  const scoped = pluginCatalogForScope(context, catalog);
  const inDetail = !!visibleEntry || !!view;
  const remember = useResourceReturnFocus(inDetail);
  return (
    <section aria-label="原生插件管理" className="min-w-0 space-y-4">
      <PluginFailureMessage failure={failure} retry={() => setRefresh((n) => n + 1)} />
      {operations
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10)
        .map((operation) => (
          <NativePluginOperation
            key={`${operation.operationId}:${operation.shownCommand?.sha256 ?? ''}`}
            operation={operation}
            busy={busy || (operation.status === 'prepared' && !!activeIds)}
            onStart={(confirmation) =>
              void run(
                () =>
                  nativePluginsApi.start(context, {
                    operationId: operation.operationId,
                    revision: operation.revision,
                    ...(confirmation ? { confirmation } : {}),
                  }),
                { operationId: operation.operationId },
              )
            }
            onCancel={() => void run(() => nativePluginsApi.cancel(context, operation.operationId))}
          />
        ))}
      {scoped ? (
        <>
          {scoped.warnings.map((warning) => (
            <p key={warning} className="text-xs text-muted-foreground">
              {warning}
            </p>
          ))}
          <div hidden={inDetail}>
            <PluginList
              catalog={scoped}
              locked={locked}
              onDetail={(entry, button) => {
                remember(button);
                setDetail({ entry });
              }}
              onView={(next, button) => {
                remember(button);
                setView(next);
              }}
            />
          </div>
          {visibleEntry && (
            <NativePluginDetails
              key={visibleEntry.id}
              context={context}
              entry={visibleEntry}
              busy={locked || previewPending(configuration)}
              onPrepare={(input) => void prepare(input)}
              onClose={() => setDetail(undefined)}
            >
              <PluginActions
                entry={visibleEntry}
                busy={locked || previewPending(configuration)}
                onPrepare={(input) => void prepare(input)}
              />
            </NativePluginDetails>
          )}
          {view === 'install' && (
            <NativePluginInstall
              catalog={scoped}
              busy={locked}
              onBack={() => setView(undefined)}
              onPrepare={(input) => {
                void prepare(input).then((operation) => {
                  if (operation) setView(undefined);
                });
              }}
            />
          )}
          {view === 'markets' && (
            <PluginMarkets
              markets={scoped.marketplaces}
              locked={locked}
              prepare={(input) => void prepare(input)}
              onBack={() => setView(undefined)}
            />
          )}
        </>
      ) : (
        !failure && <p role="status">正在读取原生插件…</p>
      )}
    </section>
  );
}

function pluginCatalogForScope(context: NativeManagementContext, catalog?: NativePluginCatalog) {
  return (
    catalog && {
      ...catalog,
      entries: catalog.entries.filter((entry) => inNativeScope(context, entry.scope)),
      marketplaces: catalog.marketplaces.filter((market) => inNativeScope(context, market.scope)),
      installScopes: catalog.installScopes.filter((scope) => inNativeScope(context, scope)),
    }
  );
}

function PluginMarkets({
  markets,
  locked,
  prepare,
  onBack,
}: {
  markets: NativePluginCatalog['marketplaces'];
  locked: boolean;
  prepare(input: NativePluginPrepareInput): void;
  onBack(): void;
}) {
  return (
    <ResourceDetails title="市场来源" onBack={onBack}>
      {markets.map((market) => (
        <article key={market.id} className="space-y-2 border-b border-border py-2">
          <p className="break-all text-sm">
            {market.name} · {pluginScopeLabel(market.scope)}
          </p>
          <p className="break-all text-xs text-muted-foreground">{market.source}</p>
          <div className="flex flex-wrap gap-2">
            {market.actions.map((action) => (
              <button
                key={action}
                type="button"
                className={buttonClass('outline')}
                disabled={locked}
                onClick={() => prepare({ action, id: market.id, revision: market.revision })}
              >
                {labels[action]}
              </button>
            ))}
          </div>
        </article>
      ))}
    </ResourceDetails>
  );
}
