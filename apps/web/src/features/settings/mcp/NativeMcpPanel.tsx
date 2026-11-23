import { useEffect, useState } from 'react';
import { Cable, Plus } from 'lucide-react';
import type {
  NativeManagementContext,
  NativeMcpEntry,
  NativeMcpOperation,
  NativeMcpSource,
  NativeMcpStatus,
} from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../../ui/styles';
import { nativeMcpApi, type McpCatalog } from './native-mcp-api';
import { nativeScopeNames, nativeSettingsError } from '../resources/native-resource-labels';
import NativeMcpEditor from './NativeMcpEditor';
import { McpOAuthCard } from './NativeMcpRuntime';
import { NativeMcpDetails } from './NativeMcpDetails';
import {
  catalogListClass,
  ResourceDetails,
  ResourceEmpty,
  ResourceRow,
  useResourceReturnFocus,
} from '../resources/ResourceList';
import { inNativeScope } from '../resources/native-resource-scope';
import { useGuardedSettingsNavigation, useSettingsLeave } from '../navigation/settings-navigation';
import { SessionToolsPanel } from './SessionToolsPanel';
type Editor = { entry?: NativeMcpEntry; source: NativeMcpSource };
function Instances({ catalog, id, setId }: { catalog: McpCatalog; id: string; setId(value: string): void }) {
  if (!catalog.instances.length) return null;
  return (
    <label className="flex max-w-xl flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="shrink-0">运行实例</span>
      <select className={`${inputClass} min-w-40 flex-1 py-1.5`} value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">项目配置与单次检查</option>
        {catalog.instances.map((i) => (
          <option key={i.instanceId} value={i.instanceId}>
            {i.sessionId ?? '新会话'} · {i.cwd ? `${i.cwd} · ` : ''}
            {i.instanceId.slice(0, 8)}
          </option>
        ))}
      </select>
    </label>
  );
}
function useCatalog(context: NativeManagementContext, reload: number, instanceId: string) {
  const [catalog, setCatalog] = useState<McpCatalog>(),
    [error, setError] = useState('');
  const { agent, projectId } = context;
  useEffect(() => {
    const controller = new AbortController();
    void nativeMcpApi
      .read({ agent, projectId }, controller.signal, instanceId || undefined)
      .then((value) => {
        if (!controller.signal.aborted) {
          setCatalog(value);
          setError('');
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(nativeSettingsError(reason));
      });
    return () => controller.abort();
  }, [agent, projectId, reload, instanceId]);
  return { catalog, error };
}
function McpCatalogList({
  entries,
  onAdd,
  onOpen,
}: {
  entries: NativeMcpEntry[];
  onOpen(id: string, trigger: HTMLButtonElement): void;
  onAdd?: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{entries.length} 个 MCP 服务</span>
        {onAdd && (
          <button type="button" className={buttonClass('primary')} onClick={(event) => onAdd(event.currentTarget)}>
            <Plus aria-hidden className="size-4" />
            添加 MCP
          </button>
        )}
      </div>
      {entries.length ? (
        <ul className={catalogListClass}>
          {entries.map((entry) => (
            <ResourceRow
              key={entry.id}
              name={entry.name}
              icon={Cable}
              description={
                entry.owner ? `来自插件 ${entry.owner}` : entry.transport !== 'unknown' ? entry.transport : undefined
              }
              status={entry.enabled === null ? undefined : entry.enabled ? '配置已启用' : '配置已禁用'}
              onOpen={(trigger) => onOpen(entry.id, trigger)}
            />
          ))}
        </ul>
      ) : (
        <ResourceEmpty>暂无 MCP 配置。</ResourceEmpty>
      )}
    </div>
  );
}

function McpEditorView({
  context,
  editor,
  writable,
  onSource,
  onClose,
  onSaved,
}: {
  context: NativeManagementContext;
  editor: Editor;
  writable: NativeMcpSource[];
  onSource(source: NativeMcpSource): void;
  onClose(): void;
  onSaved(): void;
}) {
  const leave = useGuardedSettingsNavigation();
  return (
    <ResourceDetails title={editor.entry ? `编辑 ${editor.entry.name}` : '添加 MCP'} onBack={() => leave(onClose)}>
      {!editor.entry && writable.length > 1 && (
        <label className="block max-w-xs space-y-1 text-sm">
          配置范围
          <select
            className={inputClass}
            value={editor.source.id}
            onChange={(event) => {
              const source = writable.find((item) => item.id === event.target.value);
              if (source) leave(() => onSource(source));
            }}
          >
            {writable.map((source) => (
              <option key={source.id} value={source.id}>
                {nativeScopeNames[source.scope]}
              </option>
            ))}
          </select>
        </label>
      )}
      <NativeMcpEditor
        key={editor.entry?.id ?? editor.source.id}
        context={context}
        {...editor}
        onClose={onClose}
        onSaved={onSaved}
      />
    </ResourceDetails>
  );
}

function mergeOAuth(catalog: McpCatalog, startedOperations: NativeMcpOperation[]) {
  const operations = new Map(startedOperations.map((operation) => [operation.id, operation]));
  for (const operation of catalog.operations ?? []) operations.set(operation.id, operation);
  return [...operations.values()];
}

const checkKey = ({ id, revision }: NativeMcpEntry) => JSON.stringify([id, revision]);

function CatalogBody({
  context,
  catalog,
  instanceId,
  onChanged,
}: {
  context: NativeManagementContext;
  catalog: McpCatalog;
  instanceId: string;
  onChanged(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [startedOperations, setStartedOperations] = useState<NativeMcpOperation[]>([]);
  const [checks, setChecks] = useState<Record<string, NativeMcpStatus>>({});
  const entries = catalog.entries.filter(
    (entry) => entry.managedBy !== 'session-tools' && inNativeScope(context, entry.scope),
  );
  const sources = catalog.sources.filter((source) => inNativeScope(context, source.scope));
  const writable = sources.filter((source) => source.writable);
  const detail = entries.find((entry) => entry.id === selected);
  const inDetail = !!detail || !!editor;
  const remember = useResourceReturnFocus(inDetail);
  useSettingsLeave((action) => {
    if (!busy) action();
  }, busy);
  async function change(entry: NativeMcpEntry, action: 'delete' | 'enable' | 'disable') {
    if (action === 'delete' && !window.confirm(`删除 ${entry.name} 的${nativeScopeNames[entry.scope]}持久配置？`))
      return;
    setBusy(true);
    setError('');
    try {
      await nativeMcpApi.change(context, { id: entry.id, revision: entry.revision, action });
      if (action === 'delete') setSelected(undefined);
      onChanged();
    } catch (reason) {
      setError(nativeSettingsError(reason));
    } finally {
      setBusy(false);
    }
  }
  function edit(entry: NativeMcpEntry) {
    const source = sources.find((item) => item.id === entry.sourceId);
    if (source) setEditor({ entry, source });
    setError('');
  }
  const initialSource = writable[0];
  return (
    <>
      {catalog.warnings.map((warning) => (
        <p key={warning} className="text-sm text-muted-foreground">
          {warning}
        </p>
      ))}
      <div hidden={inDetail}>
        <McpCatalogList
          entries={entries}
          onOpen={(id, button) => {
            remember(button);
            setSelected(id);
          }}
          onAdd={
            initialSource &&
            ((button) => {
              remember(button);
              setEditor({ source: initialSource });
            })
          }
        />
      </div>
      {editor ? (
        <McpEditorView
          context={context}
          editor={editor}
          writable={writable}
          onSource={(source) => setEditor({ source })}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            onChanged();
          }}
        />
      ) : (
        detail && (
          <ResourceDetails
            title={detail.name}
            onBack={() => {
              if (!busy) {
                setSelected(undefined);
                setError('');
              }
            }}
          >
            <NativeMcpDetails
              key={detail.id}
              context={context}
              entry={detail}
              instanceId={instanceId}
              busy={busy}
              edit={() => edit(detail)}
              change={(action) => void change(detail, action)}
              check={{
                status: checks[checkKey(detail)],
                setStatus: (status) => setChecks((previous) => ({ ...previous, [checkKey(detail)]: status })),
              }}
              onOperation={(operation) => setStartedOperations((previous) => [...previous, operation])}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            )}
          </ResourceDetails>
        )
      )}
      {mergeOAuth(catalog, startedOperations).map((operation) => (
        <McpOAuthCard key={operation.id} context={context} initial={operation} />
      ))}
    </>
  );
}
export default function NativeMcpPanel({
  context,
  reload,
  onChanged,
}: {
  context: NativeManagementContext;
  reload: number;
  onChanged(): void;
}) {
  const { agent, projectId } = context;
  const [instanceId, setInstanceId] = useState('');
  const leave = useGuardedSettingsNavigation();
  const [retry, setRetry] = useState(0);
  const { catalog, error } = useCatalog(context, reload + retry, instanceId);
  const current = catalog && (catalog.instanceId ?? '') === instanceId;
  return (
    <section aria-label="MCP 管理" className="min-w-0 space-y-4">
      {!projectId && (
        <SessionToolsPanel compact key={agent} agent={agent} reload={reload + retry} onChanged={onChanged} />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}{' '}
          <button type="button" className="underline" onClick={() => setRetry((n) => n + 1)}>
            重试
          </button>
        </p>
      )}
      {catalog && <Instances catalog={catalog} id={instanceId} setId={(id) => leave(() => setInstanceId(id))} />}
      {current ? (
        <CatalogBody
          key={instanceId}
          context={context}
          catalog={catalog}
          instanceId={instanceId}
          onChanged={onChanged}
        />
      ) : (
        !error && <p role="status">正在读取 MCP 配置…</p>
      )}
    </section>
  );
}
