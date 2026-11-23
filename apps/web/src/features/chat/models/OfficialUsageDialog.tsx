import { useEffect, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OfficialUsage } from '@agentdeck/shared/conversation';
import { request } from '../../../lib/http';
import { DetailDialog } from '../../../ui/DetailDialog';
import { buttonClass } from '../../../ui/styles';

type State = {
  scope: string;
  loading: boolean;
  report?: OfficialUsage;
  error?: string;
};

/** 账号连接共用短期缓存；关闭只取消请求，保留上次结果供再次查看。 */
export function useOfficialUsage(scope: string | undefined, endpoint?: string) {
  const client = useQueryClient();
  const [openedScope, setOpenedScope] = useState<string>();
  const key = ['official-usage', scope] as const;
  const query = useQuery<OfficialUsage>({ queryKey: key, queryFn: skipToken, retry: false, gcTime: 10 * 60_000 });
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: ['official-usage', scope], exact: true });
    },
    [client, scope],
  );
  const view: State | undefined =
    scope && openedScope === scope
      ? {
          scope,
          loading: query.isFetching || (!query.data && !query.error),
          report: query.data,
          error: query.error?.message,
        }
      : undefined;
  function close() {
    void client.cancelQueries({ queryKey: key, exact: true });
    setOpenedScope(undefined);
  }
  function read() {
    if (!scope || !endpoint) return;
    setOpenedScope(scope);
    void client
      .fetchQuery({
        queryKey: key,
        queryFn: ({ signal }) => request<OfficialUsage>(endpoint, { method: 'POST', signal, cache: 'no-store' }),
        staleTime: openedScope === scope || query.isError ? 0 : 60_000,
        retry: false,
      })
      .catch(() => undefined);
  }
  return { view, close, read };
}

const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
function remainingLabel(fraction?: number) {
  if (fraction === undefined) return '—';
  return fraction > 0 && fraction < 0.001 ? '<0.1%' : percent.format(fraction);
}
function resetLabel(at?: string) {
  const stamp = at ? Date.parse(at) : NaN;
  return Number.isFinite(stamp) ? `重置：${time.format(stamp)}` : '';
}
function UsageGroups({ groups }: { groups: OfficialUsage['groups'] }) {
  if (!groups.length) return <p role="status">暂无额度数据。</p>;
  return groups.map((group, index) => (
    <section key={`${group.name}-${index}`} className="space-y-2 rounded-xl border border-border p-3">
      <h3 className="break-words font-medium">{group.name}</h3>
      {!group.buckets.length && <p className="text-xs text-muted-foreground">—</p>}
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
