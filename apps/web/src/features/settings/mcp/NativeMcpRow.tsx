import { ChevronRight } from 'lucide-react';
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
  return enabled === null ? '' : enabled ? '配置已启用' : '配置已禁用';
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
      {(entry.enabled ? entry.actions.disable : entry.actions.enable) && (
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
    <details className="group min-w-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {persistentLabel(entry.enabled) || entry.transport}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground group-open:rotate-90" aria-hidden />
      </summary>
      <div className="space-y-2 pb-3">
        <p className="break-words text-xs text-muted-foreground">
          {nativeScopeNames[entry.scope]} · {entry.owner ? `来自插件 ${entry.owner}` : entry.source} · {entry.transport}
        </p>
        {(entry.config.urlOrigin || entry.config.command) && (
          <p className="break-all text-sm">{entry.config.urlOrigin ?? entry.config.command}</p>
        )}
        {entry.reason && <p className="text-sm text-muted-foreground">{entry.reason}</p>}
        <RowActions {...props} />
        <NativeMcpRuntime
          key={`${entry.revision}:${instanceId}`}
          context={context}
          entry={entry}
          instanceId={instanceId || undefined}
        />
      </div>
    </details>
  );
}
