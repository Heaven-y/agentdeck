import { record, list, type RecordValue } from '../run/types';
export const MEDIA_RPC_BYTES = 32 * 1024 * 1024;
export function mediaInput(method: unknown, params: RecordValue): boolean {
  return (
    (method === 'turn/start' || method === 'turn/steer') &&
    Array.isArray(params.input) &&
    params.input.some((value) => ['image', 'localImage'].includes(String(record(value).type)))
  );
}
export function mediaHistory(method: string, params: RecordValue): boolean {
  return (
    (method === 'thread/read' && params.includeTurns === true) ||
    (method === 'thread/turns/list' && params.itemsView === 'full') ||
    (method === 'thread/resume' && params.excludeTurns !== true)
  );
}
export function mediaNotification(message: RecordValue): boolean {
  if (!['item/started', 'item/completed'].includes(String(message.method))) return false;
  return mediaItem(record(record(message.params).item));
}
export function mediaResponse(message: RecordValue): boolean {
  const result = record(message.result);
  const turns = [...list(record(result.thread).turns), ...list(result.data)];
  return turns.some((turn) => list(record(turn).items).some((item) => mediaItem(record(item))));
}
function mediaItem(item: RecordValue): boolean {
  const content =
    item.type === 'userMessage'
      ? item.content
      : item.type === 'mcpToolCall'
        ? record(item.result).content
        : item.type === 'dynamicToolCall'
          ? item.contentItems
          : undefined;
  return (
    Array.isArray(content) &&
    content.some((value) => ['image', 'inputImage', 'localImage'].includes(String(record(value).type)))
  );
}
