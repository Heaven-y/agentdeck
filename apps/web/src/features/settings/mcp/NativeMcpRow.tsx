import type { NativeManagementContext, NativeMcpEntry } from '@agentdeck/shared/settings';
import { buttonClass } from '../../../ui/styles';
import { nativeScopeNames } from '../resources/native-resource-labels';
import NativeMcpRuntime from './NativeMcpRuntime';
type Props = {
  context: NativeManagementContext;
  entry: NativeMcpEntry;
  instanceId: string;
  busy: boolean;
  editing: boolean;
  edit(): void;
  change(action: 'enable' | 'disable' | 'delete'): void;
};
function persistentLabel(enabled: boolean | null) {
  return enabled === null ? '由 CLI 管理' : enabled ? '已启用' : '已禁用';
}
function RowActions({ entry, busy, editing, edit, change }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {entry.actions.edit && (
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={busy || editing}
          onClick={edit}
          aria-label={`编辑 ${entry.name}`}
        >
          编辑
        </button>
      )}
      {entry.actions.disable && (
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={busy}
          onClick={() => change(entry.enabled ? 'disable' : 'enable')}
        >
          {entry.enabled ? '禁用配置' : '启用配置'}
        </button>
      )}
      {entry.actions.delete && (
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={busy}
          aria-label={`删除 ${entry.name}`}
          onClick={() => change('delete')}
        >
          删除
        </button>
      )}
    </div>
  );
}
export function NativeMcpRow(props: Props) {
  const { entry, context, instanceId } = props;
  return (
    <article className="min-w-0 space-y-3 rounded-lg border border-border p-4">
      <div>
        <h3 className="break-all font-medium">{entry.name}</h3>
        <p className="break-words text-sm text-muted-foreground">
          {nativeScopeNames[entry.scope]} · {entry.owner ? `来自插件 ${entry.owner}` : entry.source} · {entry.transport}
        </p>
      </div>
      <p className="break-all text-sm">
        配置：{persistentLabel(entry.enabled)}
        {entry.config.urlOrigin ? ` · ${entry.config.urlOrigin}` : ''}
        {entry.config.command ? ` · ${entry.config.command}` : ''}
      </p>
      {entry.reason && <p className="text-sm text-muted-foreground">{entry.reason}</p>}
      <RowActions {...props} />
      <NativeMcpRuntime
        key={`${entry.revision}:${instanceId}`}
        context={context}
        entry={entry}
        instanceId={instanceId || undefined}
      />
    </article>
  );
}
