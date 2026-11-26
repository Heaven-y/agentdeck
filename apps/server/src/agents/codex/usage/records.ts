import { UsageReadError } from '../../common/usage/contracts';
import { readCodexSubagents } from '../history/subagents';
import type { UsageRecord } from '@agentdeck/shared/usage';
import { count, record, text, timestamp, type UsageProvider, type UsageScope } from '../../common/usage/contracts';
import { readUsageLines } from '../../common/usage/jsonl';
import { codexSessionRecordPath } from '../history/sessions';

/** 单响应记录与累计快照分开；只收属于原线程的usage，不重算分支继承前缀。 */
export function codexUsageCollector(scope: UsageScope) {
  const records = new Map<string, UsageRecord>();
  let owner = '',
    provider: string | undefined,
    model: string | undefined;
  return {
    records,
    visit: (value: unknown) => {
      const line = record(value),
        payload = record(line.payload);
      if (line.type === 'session_meta') {
        owner = text(payload.id);
        provider = optionalText(payload.model_provider);
        return;
      }
      if (line.type === 'turn_context') {
        model = optionalText(payload.model);
        return;
      }
      if (settingsEvent(line, payload)) {
        if (payload.thread_id === owner) {
          const settings = record(payload.thread_settings);
          model = text(settings.model) || undefined;
          provider = text(settings.model_provider_id) || provider;
        }
        return;
      }
      if (!ownedUsage(line, payload, owner, scope.sessionId)) return;
      const projected = projectUsage(line, payload, scope, { model, provider });
      if (projected) records.set(projected.id, projected);
    },
  };
}
type Cursor = { queue: Array<{ id: string; parent?: string }>; visited: string[] };
export function codexUsageProvider(environment: () => Promise<NodeJS.ProcessEnv>): UsageProvider {
  return {
    async read(scope, cursor, signal) {
      const state: Cursor = cursor ? (JSON.parse(cursor) as Cursor) : { queue: [{ id: scope.sessionId }], visited: [] };
      const target = state.queue[0]!;
      if (state.visited.includes(target.id)) throw new UsageReadError('原生子代理关系出现循环。');
      const options = { signal, env: await environment(), directoryOnly: true };
      if (target.parent)
        await readCodexSubagents(
          scope.sessionId,
          scope.dir,
          { agentId: target.id, parentAgentId: target.parent === scope.sessionId ? undefined : target.parent },
          options,
        );
      const file = await codexSessionRecordPath(target.id, scope.dir, options);
      const collector = codexUsageCollector({ ...scope, sessionId: target.id });
      await readUsageLines(file, collector.visit, signal);
      const descendants = await readCodexSubagents(
        scope.sessionId,
        scope.dir,
        target.id === scope.sessionId ? {} : { parentAgentId: target.id },
        options,
      );
      if (!('agentIds' in descendants)) throw new UsageReadError('子代理目录读取失败。');
      const queue = [...state.queue.slice(1), ...descendants.agentIds.map((id) => ({ id, parent: target.id }))];
      return {
        records: [...collector.records.values()].map((row) => ({
          ...row,
          sessionId: scope.sessionId,
          childId: target.parent ? target.id : undefined,
        })),
        nextCursor: queue.length ? JSON.stringify({ queue, visited: [...state.visited, target.id] }) : undefined,
      };
    },
  };
}

function projectUsage(
  line: Record<string, unknown>,
  payload: Record<string, unknown>,
  scope: UsageScope,
  config: { model?: string; provider?: string },
): UsageRecord | undefined {
  const { model, provider } = config;
  const responseId = text(payload.response_id),
    time = timestamp(line.timestamp),
    usage = record(payload.usage);
  if (!responseId || time === undefined) return;
  const input = count(usage.input_tokens),
    cacheRead = count(usage.cached_input_tokens),
    cacheWrite = count(usage.cache_write_input_tokens);
  const id = `codex:${scope.sessionId}:${responseId}`;
  return {
    id,
    agent: 'codex',
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    turnId: text(payload.turn_id) || undefined,
    timestamp: time,
    model,
    modelSource: model ? 'configuration' : 'unknown',
    provider,
    source: 'codex-usage-record',
    inputTotal: input,
    tokens: {
      input:
        input !== undefined && cacheRead !== undefined && input >= cacheRead
          ? cacheWrite !== undefined && input >= cacheRead + cacheWrite
            ? input - cacheRead - cacheWrite
            : undefined
          : undefined,
      cacheRead,
      cacheWrite,
      output: count(usage.output_tokens),
    },
    outputFinal: true,
  };
}

function ownedUsage(line: Record<string, unknown>, payload: Record<string, unknown>, owner: string, expected: string) {
  return line.type === 'token_usage_record' && owner === expected && payload.thread_id === owner;
}

function settingsEvent(line: Record<string, unknown>, payload: Record<string, unknown>) {
  return line.type === 'event_msg' && payload.type === 'thread_settings_applied';
}

const optionalText = (value: unknown) => text(value) || undefined;
