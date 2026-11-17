// 把 Agent 事件转成界面条目：实时对话和历史记录共用，纯函数，不修改入参
import {
  NativeSessionIdSchema,
  type AgentEvent,
  type CompactionState,
  type UserInteraction,
  type InteractionResolution,
  type MessageAttachment,
  type AsyncQuestion,
  type AsyncQuestionState,
  type InteractionAnswer,
} from '@agentdeck/shared/conversation';
import { finiteCount, type ChatStatistics } from './chat-metrics';

export type ChatItem =
  | {
      kind: 'async-question';
      id: string;
      question: AsyncQuestion;
      status: AsyncQuestionState['status'];
      responding?: boolean;
      error?: string;
      dismissed?: boolean;
      answer?: InteractionAnswer;
      recovery?: { id: string; checking?: boolean };
    }
  | {
      kind: 'interaction';
      id: string;
      interaction: UserInteraction;
      resolved?: InteractionResolution;
      responding?: boolean;
    }
  | ({ kind: 'statistics'; id: string; nativeId?: string; turnFailed?: boolean } & ChatStatistics)
  | (Omit<Extract<AgentEvent, { type: 'activity' }>, 'type'> & {
      kind: 'activity';
      nativeId?: string;
      incomplete?: boolean;
    })
  | { kind: 'fork-point'; id: string; pointId: string }
  | { kind: 'compaction'; id: string; state: CompactionState; incomplete?: boolean }
  | { kind: 'user'; id: string; text: string; attachments?: MessageAttachment[]; clientMessageId?: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; responseModel?: string }
  | { kind: 'reasoning'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      nativeId?: string;
      name: string;
      input: unknown;
      output?: string;
      attachments?: MessageAttachment[];
      isError?: boolean;
      durationMs?: number;
      timingSource?: 'native' | 'observed';
      usage?: ChatStatistics['usage'];
      progress?: string;
      status: 'running' | 'done' | 'incomplete';
    }
  | {
      kind: 'permission';
      id: string;
      toolName: string;
      input: unknown;
      description?: string;
      resolved?: 'allow' | 'deny' | 'cancelled';
      responding?: boolean;
    }
  | { kind: 'error'; id: string; message: string };

/**
 * 用位置生成 id：追加时天然唯一且稳定（用作 React key）。
 * 条目可被关闭删除，长度会回退，因此还要跳过仍在使用的位置，避免 id 重复。
 */
function nextId(items: ChatItem[], kind: string): string {
  const used = new Set(items.map((item) => item.id));
  let index = items.length;
  while (used.has(`${kind}-${index}`)) index += 1;
  return `${kind}-${index}`;
}

function canAppendAssistant(
  item: ChatItem | undefined,
  responseModel?: string,
): item is Extract<ChatItem, { kind: 'assistant' }> {
  return item?.kind === 'assistant' && item.streaming && item.responseModel === responseModel;
}

function canAppendReasoning(item: ChatItem | undefined): item is Extract<ChatItem, { kind: 'reasoning' }> {
  return item?.kind === 'reasoning';
}

/** 最后一个条目是同类时拼接文本，否则追加新条目 */
function appendText(
  items: ChatItem[],
  kind: 'assistant' | 'reasoning',
  delta: string,
  responseModel?: string,
): ChatItem[] {
  const last = items.at(-1);
  if (kind === 'assistant' && canAppendAssistant(last, responseModel)) {
    return [...items.slice(0, -1), { ...last, text: last.text + delta }];
  }
  if (kind === 'reasoning' && canAppendReasoning(last)) {
    return [...items.slice(0, -1), { ...last, text: last.text + delta }];
  }
  const id = nextId(items, kind);
  return [
    ...items,
    kind === 'assistant'
      ? { kind, id, text: delta, streaming: true, ...(responseModel ? { responseModel } : {}) }
      : { kind, id, text: delta },
  ];
}

/**
 * 历史接口返回的是完整事件序列，不是实时流：`text`/`reasoning` 的 delta 可能已是一整段。
 * 复用实时对话的归并规则（连续 delta 合成一条消息、tool_result 回填工具卡片），
 * 末尾补一个 turn_end 让最后一段内容脱离流式态；只读视图不提供分叉入口，因此丢掉分叉点。
 */
export function historyItems(events: AgentEvent[]): ChatItem[] {
  const closed = [...events, { type: 'turn_end' as const, isError: false }].reduce<ChatItem[]>(reduceChat, []);
  return closed.filter((item) => item.kind !== 'fork-point');
}

export function reduceChat(items: ChatItem[], e: AgentEvent): ChatItem[] {
  switch (e.type) {
    case 'compaction':
      return updateCompaction(items, e.state);
    case 'user_message':
      return [...items, userItem(items, e)];
    case 'text':
      return appendText(items, 'assistant', e.delta, e.responseModel);
    case 'reasoning':
      return appendText(items, 'reasoning', e.delta);
    case 'tool_call':
      return appendTool(items, e);
    case 'tool_result':
    case 'tool_progress':
      return updateTool(items, e);
    case 'step_usage':
      return updateStepStatistics(items, e);
    case 'activity':
      return updateActivity(items, e);
    default:
      return reduceLifecycle(items, e);
  }
}
function asyncQuestion(items: ChatItem[], event: Extract<AgentEvent, { type: 'async_question' }>): ChatItem[] {
  const id = `question:${event.question.sessionId}:${event.question.messageId}`;
  const existing = items.find((item) => item.kind === 'async-question' && item.id === id);
  if (existing?.kind === 'async-question')
    return items.map((item) =>
      item === existing
        ? {
            ...existing,
            question: event.question,
            ...(event.answered ? { status: 'accepted' as const, responding: false } : {}),
          }
        : item,
    );
  return [
    ...items,
    { kind: 'async-question', id, question: event.question, status: event.answered ? 'accepted' : 'open' },
  ];
}

function updateActivity(items: ChatItem[], event: Extract<AgentEvent, { type: 'activity' }>): ChatItem[] {
  const { type: _type, ...data } = event;
  const index = currentNativeItem(items, 'activity', event.id);
  const activity: ChatItem = {
    ...data,
    kind: 'activity',
    id: index < 0 ? nextId(items, 'activity') : items[index]!.id,
    nativeId: event.id,
    durationMs: finiteCount(event.durationMs) ? event.durationMs : undefined,
    incomplete: false,
  };
  if (index < 0) return [...items, activity];
  return items.map((item, position) => (position === index ? { ...item, ...activity } : item));
}

function appendTool(items: ChatItem[], event: Extract<AgentEvent, { type: 'tool_call' }>): ChatItem[] {
  if (currentNativeItem(items, 'tool', event.id) >= 0) return items;
  return [
    ...items,
    {
      kind: 'tool',
      id: nextId(items, 'tool'),
      nativeId: event.id,
      name: event.name,
      input: event.input,
      status: 'running',
    },
  ];
}

/** 原生步骤 ID 可能从零重新计数，只允许更新当前用户轮次里的对应条目。 */
function currentNativeItem(items: ChatItem[], kind: 'tool' | 'activity' | 'statistics', nativeId: string): number {
  const start = items.findLastIndex((item) => item.kind === 'user');
  return items.findLastIndex(
    (item, index) => index > start && item.kind === kind && (item.nativeId ?? item.id) === nativeId,
  );
}

function toolUpdate(event: Extract<AgentEvent, { type: 'tool_result' | 'tool_progress' }>) {
  const duration = finiteCount(event.durationMs) ? { durationMs: event.durationMs } : {};
  if (event.type === 'tool_progress') return { ...duration, progress: event.message };
  return {
    durationMs: finiteCount(event.durationMs) ? event.durationMs : undefined,
    ...(event.timingSource ? { timingSource: event.timingSource } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    output: event.output,
    ...(event.attachments ? { attachments: event.attachments } : {}),
    isError: event.isError,
    status: 'done' as const,
    progress: undefined,
  };
}

function updateTool(
  items: ChatItem[],
  event: Extract<AgentEvent, { type: 'tool_result' | 'tool_progress' }>,
): ChatItem[] {
  const index = currentNativeItem(items, 'tool', event.id);
  return items.map((item, position) => {
    if (position !== index || item.kind !== 'tool') return item;
    if (event.type === 'tool_progress' && item.status !== 'running') return item;
    return { ...item, ...toolUpdate(event) };
  });
}

function failedTurnFlag(item: ChatItem | undefined): { turnFailed?: boolean } {
  return item?.kind === 'statistics' && item.turnFailed ? { turnFailed: true } : {};
}

function updateStepStatistics(items: ChatItem[], event: Extract<AgentEvent, { type: 'step_usage' }>): ChatItem[] {
  const index = currentNativeItem(items, 'statistics', event.id);
  const id = index < 0 ? nextId(items, 'step-statistics') : items[index]!.id;
  const statistics: ChatItem = {
    kind: 'statistics',
    id,
    nativeId: event.id,
    scope: 'step',
    usage: event.usage,
    ...failedTurnFlag(items[index]),
  };
  if (finiteCount(event.durationMs)) statistics.durationMs = event.durationMs;
  if (event.generation && finiteCount(event.generation.durationMs) && event.generation.durationMs > 0)
    statistics.generation = {
      durationMs: event.generation.durationMs,
      ...(finiteCount(event.generation.firstTokenMs) ? { firstTokenMs: event.generation.firstTokenMs } : {}),
    };
  return index < 0 ? [...items, statistics] : items.map((item, position) => (position === index ? statistics : item));
}

function finishItems(items: ChatItem[]): ChatItem[] {
  return items.map((item) => {
    if (item.kind === 'compaction' && item.state.status === 'running') return { ...item, incomplete: true };
    if (item.kind === 'assistant' && item.streaming) return { ...item, streaming: false };
    if (item.kind === 'tool' && item.status === 'running') return { ...item, status: 'incomplete' };
    if (item.kind === 'permission' && !item.resolved) return { ...item, resolved: 'cancelled', responding: false };
    return finishActivity(item);
  });
}

function finishActivity(item: ChatItem): ChatItem {
  if (item.kind === 'interaction' && !item.resolved && item.interaction.owner.kind === 'turn')
    return { ...item, resolved: 'cancelled', responding: false };
  return item.kind === 'activity' && item.status === 'running' ? { ...item, incomplete: true } : item;
}

function finishTurn(items: ChatItem[], event: Extract<AgentEvent, { type: 'turn_end' }>): ChatItem[] {
  const finished = markStatisticsFailure(finishStatistics(finishItems(items), event), event.isError);
  const pointId = event.forkPoint;
  if (!pointId || !NativeSessionIdSchema.safeParse(pointId).success) return finished;
  if (items.some((item) => item.kind === 'fork-point' && item.pointId === pointId)) return finished;
  return [...finished, { kind: 'fork-point', id: nextId(items, 'fork-point'), pointId }];
}

function finishStatistics(items: ChatItem[], event: Extract<AgentEvent, { type: 'turn_end' }>): ChatItem[] {
  const existing = lastTurnStatistics(items);
  if (!finiteCount(event.durationMs) && !event.usage) return items;
  const statistics: ChatItem = {
    ...existing,
    kind: 'statistics',
    id: existing?.id ?? nextId(items, 'statistics'),
    scope: 'turn',
    isError: event.isError || existing?.isError === true,
    ...reportedStatistics(event),
  };
  return existing ? items.map((item) => (item === existing ? statistics : item)) : [...items, statistics];
}

/** 回合未完成只影响页脚摘要，不把已完成的模型步骤标成失败。 */
function markStatisticsFailure(items: ChatItem[], isError: boolean): ChatItem[] {
  if (!isError) return items;
  const start = items.findLastIndex((item) => item.kind === 'user');
  return items.map((item, index) => {
    if (index <= start || item.kind !== 'statistics') return item;
    return item.scope === 'turn' ? { ...item, isError: true } : { ...item, turnFailed: true };
  });
}

function lastTurnStatistics(items: ChatItem[]): Extract<ChatItem, { kind: 'statistics' }> | undefined {
  const tail = items.findLast((item) => item.kind !== 'fork-point' && item.kind !== 'error');
  return tail?.kind === 'statistics' && tail.scope === 'turn' ? tail : undefined;
}

function reportedStatistics(event: Extract<AgentEvent, { type: 'turn_end' }>): Partial<ChatStatistics> {
  return {
    ...(finiteCount(event.durationMs) ? { durationMs: event.durationMs } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.timingSource ? { timingSource: event.timingSource } : {}),
  };
}

/** 只由原生压缩事件确认结果；轮次结束不能把未确认的压缩标成成功。 */
function updateCompaction(items: ChatItem[], state: CompactionState): ChatItem[] {
  const index = items.findLastIndex(
    (item) => item.kind === 'compaction' && item.state.status === 'running' && !item.incomplete,
  );
  if (index < 0) return [...items, { kind: 'compaction', id: nextId(items, 'compaction'), state }];
  return items.map((item, position) => (position === index ? { ...item, state } : item));
}

function reduceLifecycle(items: ChatItem[], e: AgentEvent): ChatItem[] {
  switch (e.type) {
    case 'async_question':
      return asyncQuestion(items, e);
    case 'input_attachments': {
      const index = items.findLastIndex((item) => item.kind === 'user');
      return items.map((item, position) =>
        position === index && item.kind === 'user' ? { ...item, attachments: e.attachments } : item,
      );
    }
    case 'interaction_request':
      return items.some((item) => item.kind === 'interaction' && item.id === e.interaction.id)
        ? items
        : [...items, { kind: 'interaction', id: e.interaction.id, interaction: e.interaction }];
    case 'interaction_resolved':
      return items.map((item) =>
        item.kind === 'interaction' && item.id === e.id ? { ...item, resolved: e.resolution, responding: false } : item,
      );
    case 'permission_request':
      return [
        ...items,
        { kind: 'permission', id: e.requestId, toolName: e.toolName, input: e.input, description: e.description },
      ];
    case 'turn_end':
      return finishTurn(items, e);
    case 'permission_resolved':
      return resolvePermission(items, e.requestId, e.decision);
    case 'error':
      return [...items, { kind: 'error', id: nextId(items, 'error'), message: e.message }];
    default:
      return items;
  }
}

export function resolvePermission(
  items: ChatItem[],
  requestId: string,
  decision: 'allowed' | 'denied' | 'cancelled',
): ChatItem[] {
  const resolved = { allowed: 'allow', denied: 'deny', cancelled: 'cancelled' } as const;
  return items.map((i) =>
    i.kind === 'permission' && i.id === requestId && !i.resolved
      ? { ...i, resolved: resolved[decision], responding: false }
      : i,
  );
}

export function markPermissionPending(items: ChatItem[], requestId: string): ChatItem[] {
  return items.map((item) =>
    item.kind === 'permission' && item.id === requestId && !item.resolved ? { ...item, responding: true } : item,
  );
}

function userItem(items: ChatItem[], event: Extract<AgentEvent, { type: 'user_message' }>): ChatItem {
  return {
    kind: 'user',
    id: nextId(items, 'user'),
    text: event.text,
    ...(event.attachments ? { attachments: event.attachments } : {}),
  };
}
