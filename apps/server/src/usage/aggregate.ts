import { AGENT_KINDS } from '@agentdeck/shared/conversation';
import type {
  UsageBucket,
  UsagePrice,
  UsageQuery,
  UsageRecord,
  UsageRow,
  UsageSummary,
  UsageTokens,
} from '@agentdeck/shared/usage';
import { estimate, finalToken } from './pricing';

const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
export function cacheRate(tokens: UsageTokens, inputTotal?: number): number | undefined {
  if (tokens.cacheRead === undefined) return;
  const total =
    inputTotal ?? (tokens.input === undefined ? undefined : tokens.input + tokens.cacheRead + (tokens.cacheWrite ?? 0));
  return total !== undefined && total > 0 && tokens.cacheRead <= total ? tokens.cacheRead / total : undefined;
}
export function usageRows(records: UsageRecord[], prices: UsagePrice[]): UsageRow[] {
  return records
    .toSorted((a, b) => a.timestamp - b.timestamp)
    .map((record) => ({
      ...record,
      cacheRate: cacheRate(record.tokens, record.inputTotal),
      ...estimate(record, prices),
    }));
}
function summaryAccumulator() {
  const summary: UsageSummary = {
    count: 0,
    tokens: {},
    measured: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    priced: 0,
  };
  let cached = 0,
    cacheable = 0;
  return {
    summary,
    add(row: UsageRow) {
      summary.count++;
      addTokens(summary, row);
      if (row.costUsd !== undefined) {
        summary.costUsd = (summary.costUsd ?? 0) + row.costUsd;
        summary.priced++;
      }
      if (row.cacheRate !== undefined) {
        cached += row.tokens.cacheRead!;
        cacheable += row.inputTotal ?? row.tokens.input! + row.tokens.cacheRead! + (row.tokens.cacheWrite ?? 0);
        summary.cacheRate = cached / cacheable;
      }
    },
  };
}
export function summarize(rows: UsageRow[]): UsageSummary {
  const result = summaryAccumulator();
  for (const row of rows) result.add(row);
  return result.summary;
}
function bucketCollector(query: UsageQuery) {
  const size = query.bucket === 'hour' ? 3600000 : 86400000,
    shift = -query.timezoneOffset * 60000;
  const groups = new Map<number, ReturnType<typeof summaryAccumulator>>();
  return {
    add(row: UsageRow) {
      const time = Math.floor((row.timestamp + shift) / size) * size - shift;
      let group = groups.get(time);
      if (!group) {
        group = summaryAccumulator();
        groups.set(time, group);
      }
      group.add(row);
    },
    result(): UsageBucket[] {
      return [...groups]
        .map(([timestamp, { summary }]) => ({
          timestamp,
          count: summary.count,
          tokens: Object.values(summary.tokens).reduce((a, b) => a + b, 0),
          parts: summary.tokens,
          cacheRate: summary.cacheRate,
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
    },
  };
}
export function usageBuckets(rows: UsageRow[], query: UsageQuery) {
  const result = bucketCollector(query);
  for (const row of rows) result.add(row);
  return result.result();
}
/** SQLite 逐行提供记录；只保留当前页和聚合值，历史总量不成为内存或显示门槛。 */
export async function aggregateUsage(records: AsyncIterable<UsageRecord>, query: UsageQuery, prices: UsagePrice[]) {
  const summary = summaryAccumulator(),
    buckets = bucketCollector(query);
  const models = new Set<string>(),
    providers = new Set<string>();
  const distribution = new Map<string | undefined, { model?: string; count: number; tokens: number }>();
  const agents = new Map(AGENT_KINDS.map((agent) => [agent, 0]));
  const page: UsageRow[] = [];
  for await (const record of records) {
    if (record.model) models.add(record.model);
    if (record.provider) providers.add(record.provider);
    if (!matchesUsage(record, query)) continue;
    const row = { ...record, cacheRate: cacheRate(record.tokens, record.inputTotal), ...estimate(record, prices) };
    summary.add(row);
    buckets.add(row);
    if (summary.summary.count > query.offset && page.length < 100) page.push(row);
    agents.set(row.agent, agents.get(row.agent)! + 1);
    const group = distribution.get(row.model) ?? { model: row.model, count: 0, tokens: 0 };
    group.count++;
    group.tokens += fields.reduce((sum, field) => sum + (finalToken(row, field) ?? 0), 0);
    distribution.set(row.model, group);
  }
  return {
    summary: summary.summary,
    buckets: buckets.result(),
    records: page,
    total: summary.summary.count,
    distribution: [...distribution.values()].sort((a, b) => b.tokens - a.tokens),
    agents: [...agents].map(([agent, count]) => ({ agent, count })),
    models: [...models].sort(),
    providers: [...providers].sort(),
  };
}
export function matchesUsage(row: UsageRecord, query: UsageQuery) {
  return (
    (!query.agent || row.agent === query.agent) &&
    (!query.projectId || row.projectId === query.projectId) &&
    (!query.model || row.model === query.model) &&
    (!query.provider || row.provider === query.provider)
  );
}

function addTokens(summary: UsageSummary, row: UsageRow) {
  for (const field of fields) {
    const value = finalToken(row, field);
    if (value === undefined) continue;
    summary.tokens[field] = (summary.tokens[field] ?? 0) + value;
    summary.measured[field]++;
  }
}
