import type { AgentEvent, TokenUsage } from '@agentdeck/shared/conversation';
import { managementObject as object } from '../management/management-rpc';

export const nonnegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function tokenCount(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

/** 原生 JSON 的 uint64 可能是字符串；缺字段不填零，也不合并可能重叠的分项。 */
export function stepUsage(value: unknown, headless = false): TokenUsage | undefined {
  const source = object(value);
  const fields: Record<string, string> = headless
    ? {
        inputTokens: 'input_tokens',
        outputTokens: 'output_tokens',
        cachedInputTokens: 'cache_read_tokens',
        reasoningOutputTokens: 'thinking_tokens',
        totalTokens: 'total_tokens',
      }
    : {
        inputTokens: 'inputTokens',
        outputTokens: 'outputTokens',
        cachedInputTokens: 'cacheReadTokens',
        cacheWriteInputTokens: 'cacheWriteTokens',
        reasoningOutputTokens: 'thinkingOutputTokens',
      };
  const counts = Object.fromEntries(
    Object.entries(fields).flatMap(([key, native]) => {
      const number = tokenCount(source[native]);
      return number === undefined ? [] : [[key, number]];
    }),
  );
  return Object.keys(counts).length ? { ...counts, source: 'antigravity', scope: 'step' } : undefined;
}

export function stepDuration(seconds: unknown): { durationMs?: number; timingSource?: 'native' } {
  const duration = nonnegative(seconds);
  const milliseconds = duration === undefined ? undefined : nonnegative(duration * 1000);
  return milliseconds === undefined ? {} : { durationMs: milliseconds, timingSource: 'native' };
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'string') return nonnegative(Date.parse(value));
  const parts = object(value);
  const seconds = tokenCount(parts.seconds);
  const nanos = tokenCount(parts.nanos) ?? 0;
  return seconds === undefined || nanos >= 1e9 ? undefined : nonnegative(seconds * 1000 + nanos / 1e6);
}

export function historyTiming(value: unknown): { durationMs?: number; timingSource?: 'native' } {
  const metadata = object(value);
  const start = timestamp(metadata.startedAt);
  const end = timestamp(metadata.completedAt);
  if (start === undefined || end === undefined || end < start) return {};
  return { durationMs: end - start, timingSource: 'native' };
}

function responseObjectTimestamp(value: unknown): number | undefined {
  const parts = object(value);
  const seconds = tokenCount(parts.seconds);
  if (seconds === undefined || !Number.isSafeInteger(seconds * 1000)) return;
  if (parts.nanos !== undefined && tokenCount(parts.nanos) === undefined) return;
  return timestamp(value);
}

function responseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return responseObjectTimestamp(value);
  const match =
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d{1,9}))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) return;
  const day = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) return;
  const time = timestamp(value);
  if (time === undefined) return;
  const nanos = Number((match[2] ?? '').padEnd(9, '0'));
  return time + (nanos % 1e6) / 1e6;
}

/** 回复创建至生成结束是步骤耗时，不使用工具起止或流式生成耗时代替。 */
export function historyResponseTiming(value: unknown): { durationMs?: number; timingSource?: 'native' } {
  const metadata = object(value);
  const start = responseTimestamp(metadata.createdAt);
  const end = responseTimestamp(metadata.finishedGeneratingAt);
  if (start === undefined || end === undefined || end <= start) return {};
  return { durationMs: end - start, timingSource: 'native' };
}

export function contextEvent(value: unknown, reportedUsage?: unknown): AgentEvent[] {
  const context = object(value);
  const used = tokenCount(context.estimatedTokensUsed);
  if (used === undefined) return [];
  const window = tokenCount(context.maxContextTokens);
  const reported = object(reportedUsage);
  const inputTokens = tokenCount(reported.inputTokens);
  const cachedInputTokens = tokenCount(reported.cacheReadTokens);
  const lastRequest =
    inputTokens === undefined && cachedInputTokens === undefined
      ? undefined
      : { inputTokens, cachedInputTokens, ...(window ? { inputBudgetTokens: window } : {}) };
  return [
    {
      type: 'context',
      usage: {
        usedTokens: used,
        source: 'antigravity_estimate',
        ...(window ? { windowTokens: window, percentage: (used / window) * 100 } : {}),
        ...(lastRequest ? { lastRequest } : {}),
      },
    },
  ];
}
