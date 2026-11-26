import type { AgentKind } from '@agentdeck/shared/conversation';
import type { UsageRecord } from '@agentdeck/shared/usage';

export type UsageScope = { agent: AgentKind; sessionId: string; projectId: string; dir: string; projectDir?: string };
export type UsagePage = { records: UsageRecord[]; nextCursor?: string };
/** 原生读取与计量含义由适配器负责，公共层只处理已投影的指标。 */
export type UsageProvider = { read(scope: UsageScope, cursor?: string, signal?: AbortSignal): Promise<UsagePage> };
/** 可直接交给同步详情的具体读取原因，不含原生正文或本机路径。 */
export class UsageReadError extends Error {}
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function timestamp(value: unknown): number | undefined {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= 0 ? time : undefined;
}
