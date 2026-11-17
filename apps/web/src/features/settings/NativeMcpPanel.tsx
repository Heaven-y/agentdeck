import { useEffect, useState } from 'react';
import type { NativeManagementContext, NativeMcpEntry, NativeMcpSource } from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../ui/styles';
import { nativeMcpApi, type McpCatalog } from './native-mcp-api';
import { nativeScopeNames, nativeSettingsError } from './native-resource-labels';
import NativeMcpEditor from './NativeMcpEditor';
import NativeMcpRuntime, { McpOAuthCard } from './NativeMcpRuntime';
import { NativeMcpRow } from './NativeMcpRow';
import { useGuardedSettingsNavigation } from './settings-navigation';
import { SessionToolsPanel } from './SessionToolsPanel';
type Editor = { entry?: NativeMcpEntry; source: NativeMcpSource };
function Sources({
  catalog,
  disabled,
  onAdd,
}: {
  catalog: McpCatalog;
  disabled: boolean;
  onAdd(source: NativeMcpSource): void;
}) {
  const [id, setId] = useState('');
  const sources = catalog.sources.filter((s) => s.writable),
    source = sources.find((s) => s.id === id) ?? sources[0];
  if (!source) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-40 flex-1 space-y-1 text-sm">
        <span>新增配置作用域</span>
        <select className={inputClass} value={source.id} onChange={(e) => setId(e.target.value)}>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className={buttonClass('outline')} disabled={disabled} onClick={() => onAdd(source)}>
        添加 MCP
      </button>
    </div>
  );
}
function Instances({ catalog, id, setId }: { catalog: McpCatalog; id: string; setId(value: string): void }) {
  if (!catalog.instances.length) return null;
  return (
    <label className="block space-y-1 text-sm">
      <span>运行实例</span>
      <select className={inputClass} value={id} onChange={(e) => setId(e.target.value)}>
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
  return { catalog, error, setError };
}
function CatalogBody({
  context,
  catalog,
  instanceId,
  onChanged,
  setError,
}: {
  context: NativeManagementContext;
  catalog: McpCatalog;
  instanceId: string;
  onChanged(): void;
  setError(value: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor>();
  const entries = catalog.entries.filter((entry) => entry.managedBy !== 'session-tools');
  async function change(entry: NativeMcpEntry, action: 'delete' | 'enable' | 'disable') {
    if (action === 'delete' && !window.confirm(`删除 ${entry.name} 的${nativeScopeNames[entry.scope]}持久配置？`))
      return;
    setBusy(true);
    setError('');
    try {
      await nativeMcpApi.change(context, { id: entry.id, revision: entry.revision, action });
      onChanged();
    } catch (reason) {
      setError(nativeSettingsError(reason));
    } finally {
      setBusy(false);
    }
  }
  function edit(entry: NativeMcpEntry) {
    const source = catalog.sources.find((s) => s.id === entry.sourceId);
    if (source) setEditor({ entry, source });
  }
  return (
    <>
      {catalog.warnings.map((warning) => (
        <p key={warning} className="text-sm text-muted-foreground">
          {warning}
        </p>
      ))}
      <Sources catalog={catalog} disabled={busy || !!editor} onAdd={(source) => setEditor({ source })} />
      {editor && (
        <NativeMcpEditor
          key={editor.entry?.id ?? editor.source.id}
          context={context}
          {...editor}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            onChanged();
          }}
        />
      )}
      {entries.map((entry) => (
        <NativeMcpRow
          key={entry.id}
          context={context}
          entry={entry}
          instanceId={instanceId}
          busy={busy}
          editing={!!editor}
          edit={() => edit(entry)}
          change={(action) => void change(entry, action)}
        />
      ))}
      {catalog.operations?.map((operation) => (
        <McpOAuthCard key={operation.id} context={context} initial={operation} />
      ))}
      {entries.length === 0 && <p className="text-sm text-muted-foreground">尚未添加其他 MCP 配置。</p>}
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
  const [instanceId, setInstanceId] = useState('');
  const leave = useGuardedSettingsNavigation();
  const { catalog, error, setError } = useCatalog(context, reload, instanceId);
  const current = catalog && (catalog.instanceId ?? '') === instanceId;
  const sessionEntry = current ? catalog.entries.find((entry) => entry.managedBy === 'session-tools') : undefined;
  return (
    <section aria-label="MCP 管理" className="min-w-0 space-y-4">
      <SessionToolsPanel key={context.agent} agent={context.agent} reload={reload} onChanged={onChanged}>
        {sessionEntry && (
          <NativeMcpRuntime
            key={`${sessionEntry.revision}:${instanceId}`}
            context={context}
            entry={sessionEntry}
            instanceId={instanceId || undefined}
          />
        )}
      </SessionToolsPanel>
      <p className="text-sm text-muted-foreground">
        持久配置与本次运行分别管理。刷新列表不会启动或连接 MCP；修改配置在下一次原生实例启动时加载。
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
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
          setError={setError}
        />
      ) : (
        !error && <p role="status">正在读取 MCP 配置…</p>
      )}
    </section>
  );
}
