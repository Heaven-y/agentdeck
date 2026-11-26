import type { OfficialUsagePrice, UsagePrice, UsageRecord, UsageRow, UsageTokens } from '@agentdeck/shared/usage';
import catalog from './official-prices.json';

export const officialPrices = catalog as OfficialUsagePrice[];
const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
export const finalToken = (row: UsageRecord, field: keyof UsageTokens) =>
  field === 'output' && !row.outputFinal ? undefined : row.tokens[field];

function totalInput(row: UsageRecord, price: OfficialUsagePrice) {
  if (row.inputTotal !== undefined) return row.inputTotal;
  const { input, cacheRead, cacheWrite } = row.tokens;
  const write = cacheWrite ?? (price.writeMode === 'none' || price.writeMode === 'storage' ? 0 : undefined);
  return input !== undefined && cacheRead !== undefined && write !== undefined ? input + cacheRead + write : undefined;
}
export function officialPriceFor(row: UsageRecord) {
  const model = row.model;
  const day = new Date(row.timestamp).toISOString().slice(0, 10);
  return officialPrices.find(
    (p) =>
      (p.model === model || p.aliases?.includes(model ?? '')) &&
      (!p.effectiveFrom || day >= p.effectiveFrom) &&
      (!p.effectiveTo || day < p.effectiveTo),
  );
}
function writeRate(row: UsageRecord, price: OfficialUsagePrice) {
  if (price.writeMode === 'input') return price.input;
  if (price.writeMode !== 'ttl' || !row.cacheWriteByTtl || !price.writeRates) return;
  const parts = Object.entries(row.cacheWriteByTtl),
    rates = price.writeRates;
  const count = parts.reduce((sum, [, value]) => sum + value, 0);
  if (count <= 0 || count !== row.tokens.cacheWrite || parts.some(([ttl]) => rates[ttl] === undefined)) return;
  return parts.reduce((sum, [ttl, value]) => sum + value * rates[ttl]!, 0) / count;
}
function ratesFor(row: UsageRecord, price: OfficialUsagePrice): UsageTokens | undefined {
  const rates: UsageTokens = {
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead,
    cacheWrite: writeRate(row, price),
  };
  if (!price.longContext) return rates;
  const input = totalInput(row, price);
  if (input === undefined) return;
  if (input > price.longContext.above) {
    for (const field of fields) {
      const value = rates[field];
      if (value !== undefined) rates[field] = value * (price.longContext.multipliers[field] ?? 1);
    }
  }
  return rates;
}
function pricedParts(row: UsageRecord, rates: UsageTokens, skipWrite: boolean) {
  let cost = 0,
    measured = 0,
    partial = false;
  for (const field of fields) {
    const count = finalToken(row, field);
    if (field === 'cacheWrite' && skipWrite && count === undefined) continue;
    if (count === undefined || (count > 0 && rates[field] === undefined)) {
      partial = true;
      continue;
    }
    measured++;
    cost += count * (rates[field] ?? 0);
  }
  return measured ? { costUsd: cost / 1000000, costPartial: partial } : {};
}
/** 官网 Standard 参考价与用户覆盖独立；原生适配器只提供计量，不复制费率规则。 */
export function estimate(
  row: UsageRecord,
  prices: UsagePrice[],
): Pick<UsageRow, 'costUsd' | 'costPartial' | 'priceSource' | 'priceSourceUrl'> {
  const custom = prices.find(
    (p) => p.agent === row.agent && p.model === row.model && p.provider === (row.provider ?? ''),
  );
  const official = custom ? undefined : officialPriceFor(row);
  const rates = custom ?? (official && ratesFor(row, official));
  if (!rates) return {};
  const skipWrite = official ? ['none', 'storage'].includes(official.writeMode) : false;
  return {
    ...pricedParts(row, rates, skipWrite),
    priceSource: custom ? 'custom' : 'official',
    priceSourceUrl: official?.sourceUrl,
  };
}
