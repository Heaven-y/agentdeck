import { useState } from 'react';
import type { NativePluginOperation as Operation } from '@agentdeck/shared/settings';
import { buttonClass } from '../../../ui/styles';
import { nativeScopeNames } from '../resources/native-resource-labels';
const scopes: Record<string, string> = { ...nativeScopeNames, unknown: '来源未标注', external: '外部来源' };
export const pluginScopeLabel = (scope: string) => scopes[scope] ?? scope;
const labels: Record<Operation['status'], string> = {
  prepared: '待开始',
  running: '执行中',
  'awaiting-confirmation': '等待命令确认',
  cancelling: '正在停止',
  cancelled: '已取消',
  succeeded: '已完成',
  failed: '未开始',
  unknown: '未能确认完成',
};
export const pluginTaskActive = (status: Operation['status']) =>
  ['running', 'awaiting-confirmation', 'cancelling'].includes(status);
export function NativePluginOperation({
  operation,
  busy,
  onStart,
  onCancel,
}: {
  operation: Operation;
  busy: boolean;
  onStart(confirmation?: string): void;
  onCancel(): void;
}) {
  const [checked, setChecked] = useState(false);
  const waiting = operation.status === 'awaiting-confirmation';
  return (
    <article
      aria-label={`插件操作 ${operation.target}`}
      className="min-w-0 space-y-3 rounded-xl border border-border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="break-all text-sm">{operation.target}</strong>
        <span role="status" className="text-sm text-muted-foreground">
          {labels[operation.status]}
        </span>
      </div>
      <p className="break-all text-sm">
        来源：{operation.source} · 范围：{pluginScopeLabel(operation.scope)}
      </p>
      <p className="text-sm text-muted-foreground">{operation.impact}</p>
      {operation.message && <p className="text-sm">{operation.message}</p>}
      {waiting && operation.shownCommand && (
        <div className="space-y-2">
          <p className="text-sm">插件请求在本机执行以下命令：</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
            {operation.shownCommand.command}
          </pre>
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer">命令校验值</summary>
            <p className="break-all font-mono">SHA-256：{operation.shownCommand.sha256}</p>
          </details>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
            允许执行以上命令
          </label>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {operation.status === 'prepared' && (
          <button type="button" className={buttonClass('primary')} disabled={busy} onClick={() => onStart()}>
            开始操作
          </button>
        )}
        {waiting && (
          <button
            type="button"
            className={buttonClass('primary')}
            disabled={busy || !checked}
            onClick={() => {
              setChecked(false);
              onStart(operation.shownCommand?.sha256);
            }}
          >
            确认并继续
          </button>
        )}
        {(operation.status === 'prepared' || pluginTaskActive(operation.status)) && (
          <button
            type="button"
            className={buttonClass('outline')}
            disabled={busy || operation.status === 'cancelling'}
            onClick={onCancel}
          >
            取消操作
          </button>
        )}
      </div>
    </article>
  );
}
