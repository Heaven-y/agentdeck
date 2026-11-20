import type { GenerationTiming, TokenUsage } from '@agentdeck/shared/conversation';
import { managementObject as object, type ManagementRecord } from '../management/management-rpc';
import { stepUsage } from './metrics';
import { matchedGenerationModel } from './generation-model';

function milliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,9})?s$/.test(value)) return;
  const result = Number(value.slice(0, -1)) * 1000;
  return Number.isFinite(result) && result <= Number.MAX_SAFE_INTEGER ? result : undefined;
}

const sameUsage = (value: unknown, expected: TokenUsage) =>
  JSON.stringify(stepUsage(value)) === JSON.stringify(expected);

/** 单一成功生成且只对应当前回复时才配对，重试、多步骤和旧元数据均不推算。 */
export function historyGeneration(
  trajectory: ManagementRecord,
  step: ManagementRecord,
  index: number,
  usage: TokenUsage,
): GenerationTiming | undefined {
  const model = matchedGenerationModel(trajectory, step, index);
  if (!model) return;
  const retries = Array.isArray(model.retryInfos) ? model.retryInfos : [];
  if (retries.length !== 1 || !sameUsage(object(retries[0]).usage, usage) || !sameUsage(model.usage, usage)) return;
  const durationMs = milliseconds(model.streamingDuration);
  if (durationMs === undefined || durationMs <= 0 || usage.outputTokens === undefined) return;
  const firstTokenMs = milliseconds(model.timeToFirstToken);
  return { durationMs, ...(firstTokenMs === undefined ? {} : { firstTokenMs }) };
}
