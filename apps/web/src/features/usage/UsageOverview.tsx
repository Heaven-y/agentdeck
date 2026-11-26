import { useState } from 'react';
import { Layers, Activity, Database, Coins } from 'lucide-react';
import type { UsageReport } from '@agentdeck/shared/usage';
import { AGENT_LABELS } from '../../cli/shared/labels';
import { SegmentedControl } from '../../ui/fields/SegmentedControl';
import { cacheColor, chartColors, percent, tokens, tokenParts } from './presentation';

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className="h-8" />;
  const maximum = Math.max(1, ...values);
  const points = values
    .map((value, i) => `${(i * 240) / (values.length - 1)},${30 - (value / maximum) * 26}`)
    .join(' ');
  return (
    <svg aria-hidden viewBox="0 0 240 34" preserveAspectRatio="none" className="mt-3 h-8 w-full">
      <polygon points={`0,34 ${points} 240,34`} fill={color} opacity="0.08" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
export function UsageOverview({ report, price }: { report: UsageReport; price(): void }) {
  const { summary, buckets, agents } = report;
  const total = Object.values(summary.tokens).reduce((sum, value) => sum + value, 0);
  const cards = [
    {
      label: '已计量 Tokens',
      value: tokens(total),
      icon: Layers,
      detail: `输入 ${tokens(summary.tokens.input)} · 输出 ${tokens(summary.tokens.output)}`,
      chart: <Sparkline values={buckets.map((b) => b.tokens)} color={chartColors[0]!} />,
    },
    {
      label: '生成次数',
      value: summary.count.toLocaleString(),
      icon: Activity,
      detail: `${agents.filter((a) => a.count).length} 个 CLI`,
      chart: (
        <div className="mt-3">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            {agents.map((a, i) => (
              <span
                key={a.agent}
                style={{ width: `${(a.count / Math.max(1, summary.count)) * 100}%`, background: chartColors[i] }}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {agents
              .filter((a) => a.count)
              .map((a) => (
                <span key={a.agent}>
                  {a.agent === 'antigravity' ? 'AGY' : AGENT_LABELS[a.agent]}{' '}
                  {Math.round((a.count / summary.count) * 100)}%
                </span>
              ))}
          </div>
        </div>
      ),
    },
    {
      label: '缓存命中率',
      value: percent(summary.cacheRate),
      icon: Database,
      color: cacheColor(summary.cacheRate),
      detail: `读取 ${tokens(summary.tokens.cacheRead)} · 写入 ${tokens(summary.tokens.cacheWrite)}`,
      chart: (
        <Sparkline
          values={buckets.flatMap((b) => (b.cacheRate === undefined ? [] : [b.cacheRate]))}
          color={chartColors[1]!}
        />
      ),
    },
    {
      label: '已知用量估价',
      value: summary.costUsd === undefined ? '—' : `$${summary.costUsd.toFixed(2)}`,
      icon: Coins,
      detail: summary.priced ? `${summary.priced.toLocaleString()} 条已计价` : '查看模型单价',
      action: price,
      chart: <p className="mt-3 text-[11px] text-muted-foreground">按模型单价估算</p>,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <section key={card.label} className="min-w-0 rounded-xl border border-border bg-card px-4 py-4">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{card.label}</span>
            <card.icon aria-hidden className="size-4" />
          </div>
          <p className={`mt-2 text-[28px] leading-9 font-semibold tracking-tight tabular-nums ${card.color ?? ''}`}>
            {card.value}
          </p>
          {card.action ? (
            <button type="button" onClick={card.action} className="mt-1 text-xs text-interactive hover:underline">
              {card.detail}
            </button>
          ) : (
            <p className="mt-1 truncate text-xs text-muted-foreground" title={card.detail}>
              {card.detail}
            </p>
          )}
          {card.chart}
        </section>
      ))}
    </div>
  );
}
export function UsageTrend({
  report,
  bucket,
  changeBucket,
  select,
}: {
  report: UsageReport;
  bucket: 'hour' | 'day';
  changeBucket(value: 'hour' | 'day'): void;
  select(from: number, to: number): void;
}) {
  const [metric, setMetric] = useState<'tokens' | 'count'>('tokens');
  const maximum = Math.max(1, ...report.buckets.map((b) => b[metric]));
  const scale = 10 ** Math.floor(Math.log10(maximum));
  const highest = Math.ceil(maximum / scale) * scale;
  const parts = tokenParts.filter((p) => report.buckets.some((b) => (b.parts[p.field] ?? 0) > 0));
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-sm font-semibold">用量趋势</h2>
        <SegmentedControl<'tokens' | 'count'>
          label="趋势指标"
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'tokens', label: 'Tokens' },
            { value: 'count', label: '次数' },
          ]}
        />
        <SegmentedControl<'hour' | 'day'>
          label="趋势粒度"
          value={bucket}
          onChange={changeBucket}
          options={[
            { value: 'hour', label: '小时' },
            { value: 'day', label: '按天' },
          ]}
        />
      </div>
      <div className="relative h-40 pl-11 pb-6">
        <div className="pointer-events-none absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between">
          {[highest, highest / 2, 0].map((value) => (
            <div key={value} className="flex items-center gap-3">
              <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                {tokens(value)}
              </span>
              <span className="flex-1 border-t border-border/70" />
            </div>
          ))}
        </div>
        <div className="relative flex h-full items-end gap-1" role="group" aria-label="用量趋势">
          {report.buckets.map((b, i) => (
            <button
              key={b.timestamp}
              type="button"
              aria-label={`${label(b.timestamp, bucket)}，查看 ${b.count} 条记录`}
              title={`${label(b.timestamp, bucket)} · ${b.tokens.toLocaleString()} Tokens · ${b.count} 次生成`}
              className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded focus-visible:outline-interactive"
              onClick={() => select(b.timestamp, b.timestamp + (bucket === 'hour' ? 3600000 : 86400000))}
            >
              <span
                className="flex w-[64%] max-w-9 flex-col-reverse overflow-hidden rounded-t-[3px] opacity-90 group-hover:opacity-100"
                style={{ height: `${(b[metric] / highest) * 100}%` }}
              >
                {metric === 'count' ? (
                  <span className="h-full bg-interactive" />
                ) : (
                  parts.map((p) => (
                    <span
                      key={p.field}
                      style={{
                        height: `${((b.parts[p.field] ?? 0) / Math.max(1, b.tokens)) * 100}%`,
                        background: p.color,
                      }}
                    />
                  ))
                )}
              </span>
              {(i % Math.max(1, Math.ceil(report.buckets.length / 7)) === 0 || i === report.buckets.length - 1) && (
                <span className="absolute -bottom-5 text-[10px] whitespace-nowrap text-muted-foreground">
                  {label(b.timestamp, bucket)}
                </span>
              )}
            </button>
          ))}
        </div>
        {!report.buckets.length && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            所选时间内暂无记录
          </p>
        )}
      </div>
      <div className="mt-3 flex min-h-4 flex-wrap justify-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {metric === 'tokens' &&
          parts.map((p) => (
            <span key={p.field} className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: p.color }} />
              {p.label}
            </span>
          ))}
      </div>
    </section>
  );
}
export function UsageDistribution({ report }: { report: UsageReport }) {
  const groups = report.distribution.slice(0, 4);
  const rest = report.distribution.slice(4).reduce((sum, g) => sum + g.tokens, 0);
  if (rest) groups.push({ model: '其他', tokens: rest, count: 0 });
  const total = groups.reduce((sum, g) => sum + g.tokens, 0);
  let position = 0;
  const stops = groups.map((g, i) => {
    const start = position;
    position += (g.tokens / Math.max(1, total)) * 100;
    return `${chartColors[i]} ${start}% ${position}%`;
  });
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">模型分布</h2>
      <div className="mt-5 flex items-center gap-5">
        <div
          aria-hidden
          className="relative hidden size-28 shrink-0 items-center justify-center rounded-full xl:flex"
          style={{ background: total ? `conic-gradient(${stops.join(',')})` : 'var(--color-muted)' }}
        >
          <div className="flex size-[82px] flex-col items-center justify-center rounded-full bg-card">
            <span className="font-semibold tabular-nums">{tokens(total)}</span>
            <span className="text-[10px] text-muted-foreground">Tokens</span>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          {groups.map((g, i) => (
            <div key={g.model ?? ''}>
              <div className="mb-1.5 flex items-center gap-2 text-xs">
                <span className="size-2 shrink-0 rounded-full" style={{ background: chartColors[i] }} />
                <span className="min-w-0 truncate" title={g.model}>
                  {g.model ?? '未记录模型'}
                </span>
                <span className="ml-auto shrink-0 font-medium tabular-nums">{tokens(g.tokens)}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(g.tokens / Math.max(1, total)) * 100}%`, background: chartColors[i] }}
                  />
                </div>
                <span className="w-10 text-right text-[10px] tabular-nums text-muted-foreground">
                  {percent(total ? g.tokens / total : 0)}
                </span>
              </div>
            </div>
          ))}
        </div>
        {!groups.length && <p className="py-12 text-sm text-muted-foreground">暂无模型用量</p>}
      </div>
    </section>
  );
}
function label(time: number, bucket: 'hour' | 'day') {
  return new Date(time).toLocaleString(
    'zh-CN',
    bucket === 'hour' ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' },
  );
}
