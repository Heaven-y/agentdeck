import { UsageReadError } from '../../common/usage/contracts';
import { createAntigravitySubagents } from '../history/subagents';
import type { UsageRecord } from '@agentdeck/shared/usage';
import { record, text, timestamp, type UsageProvider, type UsageScope } from '../../common/usage/contracts';
import type { AntigravitySessionManagement } from '../history/session-management-types';
import { stepUsage } from '../run/metrics';

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
function seconds(v: unknown) {
  return typeof v === 'string' && /^\d+(?:\.\d+)?s$/.test(v) ? Number(v.slice(0, -1)) * 1000 : undefined;
}
function generationTimes(model: Record<string, unknown>, complete: boolean) {
  const retries = list(model.retryInfos),
    durationMs = seconds(model.streamingDuration),
    firstTokenMs = seconds(model.timeToFirstToken);
  if (!complete || retries.length !== 1 || record(retries[0]).hasError || durationMs === undefined || durationMs <= 0)
    return {};
  return { durationMs, firstTokenMs, timingScope: 'generation' as const };
}
function projectGeneration(
  value: unknown,
  index: number,
  steps: Record<string, unknown>[],
  scope: UsageScope,
): UsageRecord | undefined {
  const generator = record(value),
    model = record(generator.chatModel),
    usage = stepUsage(model.usage);
  const execution = text(generator.executionId);
  if (!usage || !execution) return;
  const related = steps.filter(
    (step) => list(generator.stepIndices).includes(step.index) && record(step.metadata).executionId === execution,
  );
  const valid = related.filter((step) => {
    const source = record(record(step.metadata).sourceTrajectoryStepInfo);
    return source.cascadeId === scope.sessionId && Number(source.metadataIndex ?? 0) === index;
  });
  const times = valid.flatMap((step) => {
    const t = timestamp(record(step.metadata).createdAt);
    return t === undefined ? [] : [t];
  });
  if (!times.length) return;
  const complete =
    valid.length === list(generator.stepIndices).length &&
    valid.every((step) => step.status === 'CORTEX_STEP_STATUS_DONE');
  const actual = text(model.responseModel),
    configured = text(model.modelDisplayName);
  return {
    id: `antigravity:${execution}:${index}`,
    agent: 'antigravity',
    sessionId: scope.sessionId,
    projectId: scope.projectId,
    timestamp: Math.min(...times),
    model: actual || configured || undefined,
    modelSource: actual ? 'response' : configured ? 'configuration' : 'unknown',
    source: 'agy-generator',
    tokens: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cachedInputTokens,
      cacheWrite: usage.cacheWriteInputTokens,
    },
    outputFinal: complete,
    ...generationTimes(model, complete),
  };
}
export function antigravityUsageRecords(trajectory: Record<string, unknown>, scope: UsageScope): UsageRecord[] {
  const steps = list(trajectory.usageSteps).map(record),
    base = Number(trajectory.generatorMetadataOffset ?? 0);
  return list(trajectory.generatorMetadata).flatMap((value, index) => {
    const row = projectGeneration(value, base + index, steps, scope);
    return row ? [row] : [];
  });
}
type Cursor = {
  before?: string;
  parents?: string[];
  visited?: string[];
  relations?: Array<[string, Record<string, unknown>]>;
};
async function childUsage(
  management: AntigravitySessionManagement,
  scope: UsageScope,
  state: Cursor,
  signal?: AbortSignal,
) {
  if (!management.readUsageTrajectory) throw new UsageReadError('当前 AGY 不支持子任务用量读取。');
  const parents = state.parents!,
    parent = parents[0]!,
    visited = state.visited ?? [];
  if (visited.includes(parent)) throw new UsageReadError('原生子代理关系出现循环。');
  const relations = new Map(state.relations);
  const candidates = new Map<string, Record<string, unknown>>();
  const read = createAntigravitySubagents(async (id, dir, child, abort) => {
    const key = child?.id ?? id;
    const cached = relations.get(key);
    if (cached) return { trajectory: cached };
    const result = await management.readUsageTrajectory!(id, dir, child, abort);
    candidates.set(key, result.trajectory);
    return result;
  });
  const found = await read(scope.sessionId, scope.dir, parent ? { parentAgentId: parent } : {}, signal);
  if (!('agentIds' in found)) throw new UsageReadError('子代理目录读取失败。');
  // loader 只暂存候选；目录完成父边、子元数据和工作区的全部核验后再采集。
  for (const id of [scope.sessionId, ...found.agentIds]) {
    const candidate = candidates.get(id);
    if (!candidate) continue;
    const { generatorMetadata: _generators, usageSteps: _usage, ...relation } = candidate;
    relations.set(id, relation);
  }
  const records = found.agentIds.flatMap((id) => {
    const candidate = candidates.get(id);
    return candidate
      ? antigravityUsageRecords(candidate, { ...scope, sessionId: id }).map((row) => ({
          ...row,
          sessionId: scope.sessionId,
          childId: id,
        }))
      : [];
  });
  const next = [...parents.slice(1), ...found.agentIds];
  return {
    records,
    nextCursor: next.length
      ? JSON.stringify({ parents: next, visited: [...visited, parent], relations: [...relations] })
      : undefined,
  };
}
export function antigravityUsageProvider(management: AntigravitySessionManagement): UsageProvider {
  return {
    async read(scope, cursor, signal) {
      const state: Cursor = cursor ? (JSON.parse(cursor) as Cursor) : {};
      if (state.parents) return childUsage(management, scope, state, signal);
      if (!management.readUsageWindow) throw new UsageReadError('当前 AGY 不支持生成记录读取。');
      const page = await management.readUsageWindow(scope.sessionId, scope.dir, state.before, signal);
      return {
        records: antigravityUsageRecords(page.trajectory, scope),
        nextCursor: JSON.stringify(page.before ? { before: page.before } : { parents: [''], visited: [] }),
      };
    },
  };
}
