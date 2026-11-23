import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
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
import { useGuardedSettingsNavigation } from '../navigation/settings-navigation';
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
function PluginRow({
  entry,
  busy,
  onDetail,
  onPrepare,
}: {
  entry: NativePluginEntry;
  busy: boolean;
  onDetail(): void;
  onPrepare(input: NativePluginPrepareInput): void;
}) {
  return (
    <details className="group min-w-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.name}</span>
        {entry.enabled !== null && (
          <span className="text-xs text-muted-foreground">{entry.enabled ? '已启用' : '已禁用'}</span>
        )}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground group-open:rotate-90" aria-hidden />
      </summary>
      <div className="space-y-2 pb-3">
        {entry.version && <p className="text-xs text-muted-foreground">版本 {entry.version}</p>}
        <p className="break-all text-xs text-muted-foreground">
          {entry.source} · {pluginScopeLabel(entry.scope)}
        </p>
        {entry.reason && <p className="text-xs text-muted-foreground">{entry.reason}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass('outline')} disabled={busy} onClick={onDetail}>
            详情 · {entry.name}
          </button>
          {entry.actions
            .filter(
              (action) =>
                !['configure', 'install'].includes(action) &&
                !(action === 'enable' && entry.enabled === true) &&
                !(action === 'disable' && entry.enabled === false),
            )
            .map((action) => (
              <button
                type="button"
                className={buttonClass(action === 'uninstall' ? 'danger' : 'outline')}
                key={action}
                disabled={busy}
                onClick={() => onPrepare({ action, id: entry.id, revision: entry.revision })}
              >
                {labels[action]}
              </button>
            ))}
        </div>
      </div>
    </details>
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
  const leave = useGuardedSettingsNavigation();
  const [catalog, setCatalog] = useState<NativePluginCatalog>();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<DetailSelection>();
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
          setError('');
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(nativeSettingsError(reason));
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
          setOperations((previous) =>
            previous.map((op) => values.find((value) => value.operationId === op.operationId) ?? op),
          );
          if (values.some((op) => !pluginTaskActive(op.status))) {
            changed.current();
          }
        })
        .catch((reason) => {
          if (current) setError(nativeSettingsError(reason));
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
    setError('');
    try {
      acceptOperation(await action(), target.configurationId);
    } catch (reason) {
      await syncOperation(target.operationId);
      if (mounted.current) setError(nativeSettingsError(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const prepare = (input: NativePluginPrepareInput) =>
    void run(() => nativePluginsApi.prepare(context, input), {
      configurationId: input.action === 'configure' ? input.id : undefined,
    });
  const locked = busy || !!activeIds;
  const configuration = operations.find((operation) => operation.operationId === detail?.operationId);
  const visibleEntry = visibleDetail(detail, configuration);
  const scoped = pluginCatalogForScope(context, catalog);
  return (
    <section aria-label="原生插件管理" className="min-w-0 space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}{' '}
          <button type="button" className="underline" onClick={() => setRefresh((n) => n + 1)}>
            重新读取
          </button>
        </p>
      )}
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
          <NativePluginInstall catalog={scoped} busy={locked} onPrepare={prepare} />
          {visibleEntry && (
            <NativePluginDetails
              key={visibleEntry.id}
              context={context}
              entry={visibleEntry}
              busy={locked || previewPending(configuration)}
              onPrepare={prepare}
              onClose={() => setDetail(undefined)}
            />
          )}
          {scoped.warnings.map((warning) => (
            <p key={warning} className="text-xs text-muted-foreground">
              {warning}
            </p>
          ))}
          <div className="divide-y divide-border">
            {scoped.entries.map((entry) => (
              <PluginRow
                key={entry.id}
                entry={entry}
                busy={locked}
                onPrepare={prepare}
                onDetail={() => {
                  if (visibleEntry?.id !== entry.id) leave(() => setDetail({ entry }));
                }}
              />
            ))}
            {!scoped.entries.length && <p className="text-sm text-muted-foreground">暂无已安装插件。</p>}
          </div>
          <PluginMarkets markets={scoped.marketplaces} locked={locked} prepare={prepare} />
        </>
      ) : (
        !error && <p role="status">正在读取原生插件…</p>
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
}: {
  markets: NativePluginCatalog['marketplaces'];
  locked: boolean;
  prepare(input: NativePluginPrepareInput): void;
}) {
  if (!markets.length) return null;
  return (
    <details className="space-y-3">
      <summary className="w-fit cursor-pointer text-sm font-medium">市场来源</summary>
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
    </details>
  );
}
