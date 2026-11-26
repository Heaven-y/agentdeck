import { claudeControl } from '../run/query';
import { getSessionMessages, getSubagentMessages, listSubagents } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeReadSource } from '../history/read-source';
import type { UsageRecord } from '@agentdeck/shared/usage';
import type { UsageProvider, UsageScope } from '../../common/usage/contracts';
import { count, record, text, timestamp } from '../../common/usage/contracts';
import { claudeTokenUsage } from '../run/metrics';

export function claudeUsageRecords(messages: unknown[], scope: UsageScope, childId?: string): UsageRecord[] {
  const records = new Map<string, UsageRecord>();
  for (const value of messages) {
    const entry = record(value),
      message = record(entry.message);
    const time = timestamp(entry.timestamp),
      usage = claudeTokenUsage(message.usage, 'step');
    if (
      entry.type !== 'assistant' ||
      !text(message.id) ||
      message.model === '<synthetic>' ||
      time === undefined ||
      !usage
    )
      continue;
    const id = `claude:${text(message.id)}`;
    records.set(id, {
      id,
      agent: 'claude',
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      childId,
      timestamp: time,
      model: text(message.model) || undefined,
      modelSource: 'response',
      source: 'claude-messages',
      tokens: {
        input: usage.inputTokens,
        cacheRead: usage.cachedInputTokens,
        cacheWrite: usage.cacheWriteInputTokens,
        output: usage.outputTokens,
      },
      outputFinal: false,
      cacheWriteByTtl: cacheCreation(message.usage),
    });
  }
  return [...records.values()];
}
function cacheCreation(value: unknown) {
  const usage = record(record(value).cache_creation);
  const short = count(usage.ephemeral_5m_input_tokens),
    long = count(usage.ephemeral_1h_input_tokens);
  return short !== undefined && long !== undefined ? { '5m': short, '1h': long } : undefined;
}
/** SDK负责解析当前存储；分页仅控制返回投影，SDK 内部仍可能整读文件。 */
export const claudeUsageProvider: UsageProvider = {
  async read(scope, cursor, signal) {
    const source = await claudeControl(resolveClaudeReadSource(scope.sessionId, scope.dir), signal);
    const state = cursor ? (JSON.parse(cursor) as { offset: number; child?: number }) : { offset: 0, child: undefined };
    const children = (await claudeControl(listSubagents(scope.sessionId, { dir: source.dir }), signal)).sort();
    const childId = state.child === undefined ? undefined : children[state.child];
    const page = { dir: source.dir, limit: 200, offset: state.offset };
    signal?.throwIfAborted();
    const messages = childId
      ? await claudeControl(getSubagentMessages(scope.sessionId, childId, page), signal)
      : await claudeControl(getSessionMessages(scope.sessionId, page), signal);
    signal?.throwIfAborted();
    const nextCursor = nextPage(state, children.length, messages.length);
    return { records: claudeUsageRecords(messages, scope, childId), nextCursor };
  },
};

function nextPage(state: { offset: number; child?: number }, children: number, length: number) {
  if (length === 200) return JSON.stringify({ ...state, offset: state.offset + 200 });
  const child = state.child === undefined ? 0 : state.child + 1;
  return child < children ? JSON.stringify({ offset: 0, child }) : undefined;
}
