import { useEffect, useId, useState } from 'react';
import type { NativeActionCatalog, NativeActionPreview } from '@agentdeck/shared/conversation';
import { buttonClass, inputClass } from '../../ui/styles';

export function NativeActionConfirmation({
  preview,
  busy,
  back,
  execute,
}: {
  preview: NativeActionPreview;
  busy: boolean;
  back(): void;
  execute(): void;
}) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, preview.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [preview]);
  return (
    <>
      <p className="text-sm font-medium">{preview.notice}</p>
      {preview.removesTurns !== undefined && <p className="text-sm">将移除 {preview.removesTurns} 轮原生记录。</p>}
      {!!preview.files.length && (
        <ul className="max-h-52 list-disc overflow-y-auto pl-5 text-sm">
          {preview.files.map((file) => (
            <li key={file} className="break-all">
              {file}
            </li>
          ))}
        </ul>
      )}
      {expired && (
        <p role="status" className="text-sm text-warning">
          预览已过期，请返回重新预览。
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonClass('outline')} disabled={busy} onClick={back}>
          返回选择
        </button>
        <button type="button" className={buttonClass('primary')} disabled={busy || expired} onClick={execute}>
          {busy ? '正在回退…' : '确认执行回退'}
        </button>
      </div>
    </>
  );
}
export function NativeActionSelection({
  catalog,
  pointId,
  setPointId,
  busy,
  prepare,
}: {
  catalog: NativeActionCatalog;
  pointId: string;
  setPointId(id: string): void;
  busy: boolean;
  prepare(): void;
}) {
  const id = useId();
  return (
    <>
      {catalog.available ? (
        <label className="block space-y-2 text-sm" htmlFor={id}>
          <span>回退位置</span>
          <select
            id={id}
            className={inputClass}
            value={pointId}
            disabled={busy}
            onChange={(event) => setPointId(event.target.value)}
          >
            {catalog.candidates.map((point) => (
              <option key={point.id} value={point.id}>
                {point.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm">{catalog.reason}</p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={busy || !catalog.available || !pointId}
          onClick={prepare}
        >
          {busy ? '正在预览…' : '预览影响范围'}
        </button>
      </div>
    </>
  );
}
