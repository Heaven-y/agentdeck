import { useEffect, useRef, useState } from 'react';
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
    <article className="min-w-0 space-y-2 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="break-all text-sm">{entry.name}</strong>
        <span className="text-xs text-muted-foreground">
          {entry.enabled === null ? '状态未知' : entry.enabled ? '已启用' : '已禁用'} · {entry.version ?? '版本未知'}
        </span>
      </div>
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
    </article>
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
            setRefresh((value) => value + 1);
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
      setRefresh((value) => value + 1);
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
  return (
    <section aria-label="原生插件管理" className="min-w-0 space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
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
      {catalog ? (
        <>
          <NativePluginInstall catalog={catalog} busy={locked} onPrepare={prepare} />
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
          {catalog.warnings.map((warning) => (
            <p key={warning} className="text-xs text-muted-foreground">
              {warning}
            </p>
          ))}
          <div className="space-y-3">
            {catalog.entries.map((entry) => (
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
            {!catalog.entries.length && <p className="text-sm text-muted-foreground">此范围没有发现已安装插件。</p>}
          </div>
          {catalog.marketplaces.length > 0 && (
            <section aria-label="插件市场来源" className="space-y-3">
              <h3 className="text-sm font-medium">市场来源</h3>
              {catalog.marketplaces.map((market) => (
                <article key={market.id} className="space-y-2 rounded-xl border border-border p-4">
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
            </section>
          )}
        </>
      ) : (
        !error && <p role="status">正在读取原生插件…</p>
      )}
    </section>
  );
}
