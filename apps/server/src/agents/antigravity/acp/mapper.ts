import type { AgentEvent, TokenUsage } from '@agentdeck/shared/conversation';
import { object, text, list, type AcpRecord } from './types';

const finished = new Set(['completed', 'failed', 'cancelled']);
const clip = (value: string) => (value.length > 20_000 ? `${value.slice(0, 20_000)}\n[输出已截断]` : value);
function textChunk(value: unknown, type: 'text' | 'reasoning'): AgentEvent[] {
  const content = object(value);
  const delta = content.type === 'text' ? text(content.text) : '';
  return delta ? [{ type, delta }] : [];
}
function toolCall(id: string, value: AcpRecord): AgentEvent {
  return {
    type: 'tool_call',
    id,
    name: text(value.name) || text(value.kind) || text(value.title) || '原生工具',
    input: object(value.rawInput ?? value.args),
  };
}
function toolResult(id: string, value: AcpRecord): AgentEvent {
  return {
    type: 'tool_result',
    id,
    output: clip(contentText(value.content) || text(value.rawOutput)),
    isError: value.status !== 'completed',
  };
}
function contentText(value: unknown): string {
  return list(value)
    .map((entry) => {
      const block = object(entry);
      if (block.type === 'content') return text(object(block.content).text);
      if (block.type === 'diff') return `${text(block.path)}\n${text(block.oldText)}\n${text(block.newText)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function acpTurnUsage(value: unknown): TokenUsage | undefined {
  const source = object(value);
  const fields = {
    inputTokens: count(source.inputTokens),
    outputTokens: count(source.outputTokens),
    cachedInputTokens: count(source.cachedReadTokens),
    cacheWriteInputTokens: count(source.cachedWriteTokens),
    reasoningOutputTokens: count(source.thoughtTokens),
    totalTokens: count(source.totalTokens),
  };
  return Object.values(fields).some((value) => value !== undefined)
    ? { ...fields, source: 'antigravity', scope: 'turn' }
    : undefined;
}

/** ACP只投影公开通知；原生会话历史仍通过已核实的历史入口读取。 */
export class AntigravityAcpMapper {
  private readonly tools = new Map<string, AcpRecord>();
  private readonly ended = new Set<string>();

  update(value: AcpRecord): AgentEvent[] {
    switch (value.sessionUpdate) {
      case 'agent_message_chunk':
        return textChunk(value.content, 'text');
      case 'agent_thought_chunk':
        return textChunk(value.content, 'reasoning');
      case 'tool_call':
      case 'tool_call_update':
        return this.tool(value);
      case 'plan':
        return this.plan(value);
      case 'usage_update':
        return this.context(value);
      default:
        return [];
    }
  }

  private plan(value: AcpRecord): AgentEvent[] {
    const entries = list(value.entries).map(object);
    return [
      {
        type: 'activity',
        id: 'acp-plan',
        name: '计划',
        status: entries.length > 0 && entries.every((entry) => entry.status === 'completed') ? 'completed' : 'running',
        output: entries
          .map((entry) => text(entry.content))
          .filter(Boolean)
          .join('\n'),
      },
    ];
  }

  private tool(value: AcpRecord): AgentEvent[] {
    const id = text(value.toolCallId);
    if (!id || this.ended.has(id)) return [];
    if (this.tools.size >= 10_000 && !this.tools.has(id)) throw new Error('ACP 工具记录超限');
    const previous = this.tools.get(id);
    const current = { ...previous, ...value };
    this.tools.set(id, current);
    const events: AgentEvent[] = [];
    if (!previous) events.push(toolCall(id, current));
    if (finished.has(text(current.status))) {
      this.ended.add(id);
      events.push(toolResult(id, current));
    } else if (value.sessionUpdate === 'tool_call_update' && contentText(value.content)) {
      events.push({ type: 'tool_progress', id, message: clip(contentText(value.content)) });
    }
    return events;
  }

  private context(value: AcpRecord): AgentEvent[] {
    const used = count(value.used);
    if (used === undefined) return [];
    const window = count(value.size);
    return [
      {
        type: 'context',
        usage: { usedTokens: used, ...(window ? { windowTokens: window } : {}), source: 'antigravity_estimate' },
      },
    ];
  }
}
