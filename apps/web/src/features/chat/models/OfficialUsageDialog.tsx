import { useEffect, useRef, useState } from 'react';
import type { OfficialUsage } from '@agentdeck/shared/conversation';
import { request } from '../../../lib/http';
import { DetailDialog } from '../../../ui/DetailDialog';
import { buttonClass } from '../../../ui/styles';

type State = {
  scope: string;
  controller: AbortController;
  loading: boolean;
  report?: OfficialUsage;
  error?: string;
};

/** 仅用户点击时读；退出、切连接或关闭当前聊天后丢弃在途请求。 */
export function useOfficialUsage(scope: string | undefined, endpoint?: string) {
  const pending = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState<State>();
  useEffect(() => () => pending.current?.abort(), [scope]);
  const view = state?.scope === scope && !state?.controller.signal.aborted ? state : undefined;
  function close() {
    pending.current?.abort();
    setState(undefined);
  }
  function read() {
    if (!scope || !endpoint) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState((previous) => ({
      scope,
      controller,
      loading: true,
      report: previous?.scope === scope ? previous.report : undefined,
    }));
    void request<OfficialUsage>(endpoint, {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
    }).then(
      (report) => {
        if (!controller.signal.aborted) setState({ scope, controller, loading: false, report });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) =>
          current?.controller === controller
            ? {
                ...current,
                loading: false,
                error: cause instanceof Error ? cause.message : '暂时无法读取官方额度。',
              }
            : current,
        );
      },
    );
  }
  return { view, close, read };
}

const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
function remainingLabel(fraction?: number) {
  if (fraction === undefined) return '剩余未报告';
  return fraction > 0 && fraction < 0.001 ? '<0.1%' : percent.format(fraction);
}
function resetLabel(at?: string) {
  const stamp = at ? Date.parse(at) : NaN;
  return Number.isFinite(stamp) ? `重置：${time.format(stamp)}` : '重置时间未报告';
}
function UsageGroups({ groups }: { groups: OfficialUsage['groups'] }) {
  if (!groups.length) return <p role="status">暂无额度数据。</p>;
  return groups.map((group, index) => (
    <section key={`${group.name}-${index}`} className="space-y-2 rounded-xl border border-border p-3">
      <h3 className="break-words font-medium">{group.name}</h3>
      {!group.buckets.length && <p className="text-xs text-muted-foreground">未报告额度详情。</p>}
      <dl className="space-y-2">
        {group.buckets.map((bucket, position) => (
          <div key={`${bucket.id}-${position}`} className="flex items-start justify-between gap-3">
            <dt className="min-w-0 break-words">
              {bucket.name}
              {bucket.window && <p className="text-xs text-muted-foreground">{bucket.window}</p>}
            </dt>
            <dd className="shrink-0 text-right">
              <p>{remainingLabel(bucket.remainingFraction)}</p>
              <p className="text-xs text-muted-foreground">{resetLabel(bucket.resetAt)}</p>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  ));
}

export function OfficialUsageDialog({
  view,
  read,
  close,
  agent,
}: {
  view: State;
  read(): void;
  close(): void;
  agent: 'codex' | 'antigravity';
}) {
  const pending = view.loading;
  return (
    <DetailDialog title={`${agent === 'codex' ? 'Codex' : 'Antigravity'} 官方额度`} onClose={close}>
      <div className="space-y-3 text-sm">
        {pending && !view.report && <p role="status">正在读取额度…</p>}
        {view.error && (
          <p role="alert" className="text-warning">
            {view.error}
          </p>
        )}
        {view.report && (
          <>
            <p className="text-xs text-muted-foreground">读取于 {time.format(view.report.checkedAt)}</p>
            <UsageGroups groups={view.report.groups} />
          </>
        )}
        <button type="button" className={buttonClass('outline')} disabled={pending} onClick={read}>
          {pending && view.report ? '正在刷新…' : view.error ? '重试' : '刷新额度'}
        </button>
      </div>
    </DetailDialog>
  );
}
