import type { AgentEvent } from '@agentdeck/shared/conversation';
import type { ChatItem } from '../../conversation/model/conversation-events';

function missing(item: ChatItem): item is Extract<ChatItem, { kind: 'assistant' }> {
  return item.kind === 'assistant' && !!item.nativeId && !item.responseModel;
}

export function hasMissingResponseModels(items: ChatItem[]) {
  const start = items.findLastIndex((item) => item.kind === 'user');
  return items.some((item, index) => index > start && missing(item));
}

/** 只补本轮同一原生步骤；相同正文、配置型号和冲突的重复报告都不能作为配对依据。 */
export function refreshResponseModels(items: ChatItem[], events: AgentEvent[]): ChatItem[] {
  const models = new Map<string, string | undefined>();
  const boundary = events.findLastIndex((event) => event.type === 'user_message');
  for (const event of events.slice(boundary + 1)) {
    if (event.type !== 'text' || !event.id) continue;
    const model =
      models.has(event.id) && models.get(event.id) !== event.responseModel ? undefined : event.responseModel;
    models.set(event.id, model);
  }
  const start = items.findLastIndex((item) => item.kind === 'user');
  let changed = false;
  const refreshed = items.map((item, index) => {
    if (index <= start || !missing(item)) return item;
    const responseModel = models.get(item.nativeId!);
    if (!responseModel) return item;
    changed = true;
    return { ...item, responseModel };
  });
  return changed ? refreshed : items;
}
