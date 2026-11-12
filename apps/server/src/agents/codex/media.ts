import type { MessageAttachment } from '@agentdeck/shared/conversation';
import { mediaReference, mediaMissing, imageSource } from '../common/native-media';
import { record, list, text, type RecordValue } from './types';
function blocks(item: RecordValue): unknown[] {
  if (item.type === 'mcpToolCall') return list(record(item.result).content);
  if (item.type === 'dynamicToolCall') return list(item.contentItems);
  return [];
}
const isImage = (value: RecordValue) => ['image', 'inputImage'].includes(text(value.type));
export function codexToolMedia(item: RecordValue, sessionId?: string): { attachments?: MessageAttachment[] } {
  if (!sessionId) return {};
  const attachments =
    item.type === 'imageView'
      ? [mediaReference(sessionId, text(item.id), 0, { kind: 'tool' })]
      : blocks(item).flatMap((value, index) =>
          isImage(record(value)) ? [mediaReference(sessionId, text(item.id), index, { kind: 'tool' })] : [],
        );
  return attachments.length ? { attachments } : {};
}
export function codexToolImage(item: RecordValue, index: number) {
  if (item.type === 'imageView' && index === 0) return imageSource(item);
  const block = record(blocks(item)[index]);
  if (!isImage(block)) throw mediaMissing();
  return imageSource({ ...block, url: block.imageUrl ?? block.url });
}
export function mcpResultText(item: RecordValue): string {
  if (item.error) return typeof item.error === 'string' ? item.error : JSON.stringify(item.error);
  const result = record(item.result);
  if (!Array.isArray(result.content)) return JSON.stringify(item.result ?? null);
  return JSON.stringify({
    ...result,
    content: result.content.map((value) => {
      const block = record(value);
      return isImage(block) ? { type: 'image', mimeType: block.mimeType, description: '图片内容通过预览读取' } : block;
    }),
  });
}
