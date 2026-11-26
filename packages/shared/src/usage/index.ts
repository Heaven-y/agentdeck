import { z } from 'zod';
import { AgentKindSchema, type AgentKind } from '../conversation/agents';

/** 归一为互不重叠的分项；缺失表示原生未报告。 */
export type UsageTokens = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
export type UsageRecord = {
  id: string;
  agent: AgentKind;
  sessionId: string;
  projectId: string;
  childId?: string;
  turnId?: string;
  timestamp: number;
  model?: string;
  modelSource: 'response' | 'configuration' | 'unknown';
  provider?: string;
  source: string;
  tokens: UsageTokens;
  inputTotal?: number;
  cacheWriteByTtl?: Record<string, number>;
  outputFinal: boolean;
  durationMs?: number;
  firstTokenMs?: number;
  timingScope?: 'generation' | 'turn';
};
export const UsageQuerySchema = z
  .object({
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().positive(),
    agent: AgentKindSchema.optional(),
    projectId: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    provider: z.string().max(200).optional(),
    offset: z.coerce.number().int().min(0).default(0),
    bucket: z.enum(['hour', 'day']).default('day'),
    timezoneOffset: z.coerce.number().int().min(-840).max(840).default(0),
  })
  .strict()
  .refine((q) => q.to > q.from, { message: '结束时间必须晚于开始时间。' });
export type UsageQuery = z.infer<typeof UsageQuerySchema>;
const price = z.number().finite().min(0).max(1000000);
export const UsagePriceSchema = z
  .object({
    agent: AgentKindSchema,
    model: z.string().trim().min(1).max(200),
    provider: z.string().max(200).default(''),
    input: price,
    output: price,
    cacheRead: price,
    cacheWrite: price,
  })
  .strict();
export type UsagePrice = z.infer<typeof UsagePriceSchema>;
export type OfficialUsagePrice = UsageTokens & {
  model: string;
  aliases?: string[];
  writeMode: 'ttl' | 'input' | 'storage' | 'none';
  writeRates?: Record<string, number>;
  longContext?: { above: number; multipliers: UsageTokens };
  effectiveFrom?: string;
  effectiveTo?: string;
  sourceUrl: string;
  verifiedAt: string;
};
export const UsagePricesSchema = z
  .object({ prices: z.array(UsagePriceSchema).max(200) })
  .strict()
  .refine(
    ({ prices }) => new Set(prices.map((p) => JSON.stringify([p.agent, p.model, p.provider]))).size === prices.length,
    { message: '同一CLI、模型和供应方只能设置一项单价。' },
  );
export type UsageSummary = {
  count: number;
  tokens: UsageTokens;
  measured: Record<keyof UsageTokens, number>;
  costUsd?: number;
  priced: number;
  cacheRate?: number;
};
export type UsageRow = UsageRecord & {
  priceSource?: 'official' | 'custom';
  priceSourceUrl?: string;
  costUsd?: number;
  costPartial?: boolean;
  cacheRate?: number;
};
export type UsageBucket = { timestamp: number; count: number; tokens: number; parts: UsageTokens; cacheRate?: number };
export type UsageReport = {
  summary: UsageSummary;
  buckets: UsageBucket[];
  distribution: Array<{ model?: string; count: number; tokens: number }>;
  agents: Array<{ agent: AgentKind; count: number }>;
  records: UsageRow[];
  total: number;
  models: string[];
  providers: string[];
  prices: UsagePrice[];
  officialPrices: OfficialUsagePrice[];
  sync: UsageSyncStatus;
};
export type UsageSyncStatus = {
  id?: string;
  running: boolean;
  scanned: number;
  updated: number;
  lastSync?: number;
  errors: Array<{ agent: AgentKind; message: string }>;
};
