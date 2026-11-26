import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { AGENT_KINDS, type AgentKind } from '@agentdeck/shared/conversation';
import type { UsageQuery } from '@agentdeck/shared/usage';
import type { Workspace } from '@agentdeck/shared/projects';
import { AGENT_LABELS } from '../../cli/shared/labels';
import { inputClass } from '../../ui/styles';
import { SegmentedControl } from '../../ui/fields/SegmentedControl';

export function initialQuery(): UsageQuery {
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return {
    from: start.getTime(),
    to: end.getTime(),
    bucket: 'day',
    offset: 0,
    timezoneOffset: end.getTimezoneOffset(),
  };
}
function dateInput(time: number) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
type FilterProps = { query: UsageQuery; change(patch: Partial<UsageQuery>): void };
export function UsageDateRange({ query, change }: FilterProps) {
  const [custom, setCustom] = useState(false);
  const range = [1, 7, 30].find((days) => {
    const end = new Date();
    end.setHours(24, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    return query.from === start.getTime() && query.to === end.getTime();
  });
  const selected = custom ? 'custom' : String(range ?? 'custom');
  function choose(value: string) {
    setCustom(value === 'custom');
    if (value === 'custom') return;
    const end = new Date();
    end.setHours(24, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - Number(value));
    change({ from: start.getTime(), to: end.getTime(), bucket: value === '1' ? 'hour' : 'day' });
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <CalendarDays aria-hidden className="size-4 text-muted-foreground" />
      <select
        aria-label="日期范围"
        value={selected}
        onChange={(e) => choose(e.target.value)}
        className={`${inputClass} !w-auto py-1.5`}
      >
        <option value="1">今天</option>
        <option value="7">近 7 天</option>
        <option value="30">近 30 天</option>
        <option value="custom">自定义日期</option>
      </select>
      {selected === 'custom' && (
        <>
          <input
            type="date"
            aria-label="开始日期"
            className={`${inputClass} !w-auto max-w-36`}
            value={dateInput(query.from)}
            max={dateInput(query.to - 1)}
            onChange={(e) => {
              if (e.target.value) change({ from: new Date(`${e.target.value}T00:00:00`).getTime() });
            }}
          />
          <span>至</span>
          <input
            type="date"
            aria-label="结束日期"
            className={`${inputClass} !w-auto max-w-36`}
            value={dateInput(query.to - 1)}
            min={dateInput(query.from)}
            onChange={(e) => {
              if (e.target.value) {
                const d = new Date(`${e.target.value}T00:00:00`);
                d.setDate(d.getDate() + 1);
                change({ to: d.getTime() });
              }
            }}
          />
        </>
      )}
    </div>
  );
}
export function UsageFilters({
  query,
  change,
  projects,
  models,
  providers,
}: FilterProps & { projects: Workspace[]; models: string[]; providers: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SegmentedControl<AgentKind | 'all'>
        label="筛选 CLI"
        value={query.agent ?? 'all'}
        onChange={(agent) => change({ agent: agent === 'all' ? undefined : agent })}
        options={[
          { value: 'all', label: '全部' },
          ...AGENT_KINDS.map((agent) => ({
            value: agent,
            label: agent === 'antigravity' ? 'AGY' : AGENT_LABELS[agent],
          })),
        ]}
      />
      <div className="ml-auto flex flex-wrap gap-2">
        <select
          aria-label="筛选工作区"
          className={`${inputClass} !w-auto max-w-44`}
          value={query.projectId ?? ''}
          onChange={(e) => change({ projectId: e.target.value || undefined })}
        >
          <option value="">全部工作区</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选模型"
          className={`${inputClass} !w-auto max-w-56`}
          value={query.model ?? ''}
          onChange={(e) => change({ model: e.target.value || undefined })}
        >
          <option value="">全部模型</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {providers.length > 0 && (
          <select
            aria-label="筛选供应方"
            className={`${inputClass} !w-auto max-w-44`}
            value={query.provider ?? ''}
            onChange={(e) => change({ provider: e.target.value || undefined })}
          >
            <option value="">全部供应方</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
