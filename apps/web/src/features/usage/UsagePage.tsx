import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, Settings2 } from 'lucide-react';
import type { UsageQuery, UsageReport, UsageSyncStatus } from '@agentdeck/shared/usage';
import type { Workspace } from '@agentdeck/shared/projects';
import { AGENT_LABELS } from '../../cli/shared/labels';
import { buttonClass } from '../../ui/styles';
import { request } from '../../lib/http';
import { UsageOverview, UsageTrend, UsageDistribution } from './UsageOverview';
import { UsageRecords } from './UsageRecords';
import { UsagePrices } from './UsagePrices';
import { UsageFilters, UsageDateRange, initialQuery } from './UsageFilters';

function useUsageSync(refetch: () => Promise<unknown>) {
  const [progress, setProgress] = useState<UsageSyncStatus>(),
    [error, setError] = useState('');
  const controller = useRef<AbortController>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function start() {
    if (controller.current) return;
    const active = new AbortController();
    controller.current = active;
    setError('');
    setProgress({ running: true, scanned: 0, updated: 0, errors: [] });
    let id: string | undefined;
    try {
      for (;;) {
        const status = await request<UsageSyncStatus>('/api/usage/sync', {
          method: 'POST',
          body: JSON.stringify({ id }),
          signal: active.signal,
        });
        if (active.signal.aborted) return;
        setProgress(status);
        id = status.id;
        if (!status.running) break;
      }
      await refetch();
    } catch (e) {
      if (!active.signal.aborted) setError(e instanceof Error ? e.message : '同步失败，请重试。');
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setProgress((p) => (p ? { ...p, running: false } : p));
      }
    }
  }
  return {
    progress,
    error,
    start,
    stop: () => {
      controller.current?.abort();
      controller.current = null;
      setProgress((p) => (p ? { ...p, running: false } : p));
      void refetch();
    },
  };
}
export default function UsagePage({ projects, close }: { projects: Workspace[]; close(): void }) {
  const [pricing, setPricing] = useState(false);
  const { query, setQuery, report } = useUsageReport(projects);
  const sync = useUsageSync(() => report.refetch());
  const data = report.data;
  const change = (patch: Partial<UsageQuery>) => setQuery((current) => ({ ...current, ...patch, offset: 0 }));
  const error = report.error?.message || sync.error;
  const options = data ?? { models: [], providers: [] };
  return (
    <main className="h-full min-h-0 min-w-0 overflow-auto bg-surface-subtle">
      <div className="mx-auto max-w-[1760px] space-y-4 p-5 lg:p-6">
        <UsageHeader
          query={query}
          change={change}
          close={close}
          sync={sync}
          lastSync={data?.sync.lastSync}
          price={() => setPricing(true)}
        />
        <UsageFilters
          query={query}
          change={change}
          projects={projects}
          models={options.models}
          providers={options.providers}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        )}
        {report.isPending && (
          <p role="status" className="py-8 text-center text-sm text-muted-foreground">
            正在读取用量…
          </p>
        )}
        {data && (
          <>
            <UsageOverview report={data} price={() => setPricing(true)} />
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
              <UsageTrend
                report={data}
                bucket={query.bucket}
                changeBucket={(bucket) => change({ bucket })}
                select={(from, to) => change({ from, to })}
              />
              <UsageDistribution report={data} />
            </div>
            <UsageRecords
              rows={data.records}
              total={data.total}
              offset={query.offset}
              projects={projects}
              changeOffset={(offset) => setQuery((q) => ({ ...q, offset }))}
            />
            <SyncDetails errors={data.sync.errors} />
          </>
        )}
      </div>
      {pricing && data && (
        <UsagePrices
          prices={data.prices}
          officialPrices={data.officialPrices}
          models={data.models}
          close={() => setPricing(false)}
          saved={() => void report.refetch()}
        />
      )}
    </main>
  );
}

function UsageHeader({
  query,
  change,
  close,
  sync,
  lastSync,
  price,
}: {
  query: UsageQuery;
  change(patch: Partial<UsageQuery>): void;
  close(): void;
  sync: ReturnType<typeof useUsageSync>;
  lastSync?: number;
  price(): void;
}) {
  return (
    <header className="flex flex-wrap items-start gap-3">
      <div className="mr-auto flex items-start gap-2">
        <button type="button" aria-label="返回对话" title="返回对话" className={buttonClass('ghost')} onClick={close}>
          <ArrowLeft aria-hidden className="size-4" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">用量</h1>
          <p className="mt-1 text-xs text-muted-foreground">查看各 CLI 的用量与缓存表现</p>
        </div>
      </div>
      <UsageDateRange query={query} change={change} />
      <button
        type="button"
        className={buttonClass('outline')}
        onClick={() => (sync.progress?.running ? sync.stop() : void sync.start())}
        title={lastSync ? `上次同步：${new Date(lastSync).toLocaleString()}` : undefined}
      >
        <RefreshCw
          aria-hidden
          className={`size-3.5 ${sync.progress?.running ? 'animate-spin motion-reduce:animate-none' : ''}`}
        />
        {sync.progress?.running ? `暂停同步 · ${sync.progress.scanned}` : '同步记录'}
      </button>
      <button type="button" className={buttonClass('outline')} onClick={price}>
        <Settings2 aria-hidden className="size-4" />
        单价设置
      </button>
    </header>
  );
}

function SyncDetails({ errors }: { errors: UsageSyncStatus['errors'] }) {
  if (!errors.length) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">同步详情 · {errors.length} 个来源未完成</summary>
      <ul className="mt-2 space-y-1">
        {errors.map((e) => (
          <li key={e.agent}>
            {AGENT_LABELS[e.agent]}：{e.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

function useUsageReport(projects: Workspace[]) {
  const [query, setQuery] = useState(initialQuery);
  if (query.projectId && !projects.some((p) => p.id === query.projectId))
    setQuery({ ...query, projectId: undefined, offset: 0 });
  const report = useQuery({
    queryKey: ['usage', query, projects.map((p) => [p.id, p.dir])],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      );
      return request<UsageReport>(`/api/usage?${params}`, { signal });
    },
    retry: false,
  });

  return { query, setQuery, report };
}
