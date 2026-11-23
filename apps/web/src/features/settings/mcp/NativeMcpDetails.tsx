import type { NativeManagementContext, NativeMcpEntry, NativeMcpOperation } from '@agentdeck/shared/settings';
import { buttonClass } from '../../../ui/styles';
import { nativeScopeNames } from '../resources/native-resource-labels';
import NativeMcpRuntime, { type McpCheck } from './NativeMcpRuntime';
type Props = {
  context: NativeManagementContext;
  entry: NativeMcpEntry;
  instanceId: string;
  busy: boolean;
  onOperation(operation: NativeMcpOperation): void;
  check: McpCheck;
  edit(): void;
  change(action: 'enable' | 'disable' | 'delete'): void;
};
function RowActions({ entry, busy, edit, change }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {entry.actions.edit && (
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={busy}
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
          className={buttonClass('danger')}
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
export function NativeMcpDetails(props: Props) {
  const { entry, context, instanceId, onOperation, check } = props;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {nativeScopeNames[entry.scope]} · {entry.owner ? `来自插件 ${entry.owner}` : entry.source} · {entry.transport}
      </p>
      {(entry.config.urlOrigin || entry.config.command) && (
        <p className="text-sm [overflow-wrap:anywhere]">{entry.config.urlOrigin ?? entry.config.command}</p>
      )}
      {entry.reason && <p className="text-sm text-muted-foreground">{entry.reason}</p>}
      <RowActions {...props} />
      <NativeMcpRuntime
        key={`${entry.revision}:${instanceId}`}
        context={context}
        entry={entry}
        instanceId={instanceId || undefined}
        onOperation={onOperation}
        check={check}
      />
    </div>
  );
}
