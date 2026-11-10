import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ATTACHMENT_LIMITS, type MessageAttachment, type NativeMediaLocator } from '@agentdeck/shared/conversation';
import { SessionError } from '../errors';
import { readBoundedFile } from '../../platform/files/bounded-file';
import { imageInfo } from './media-format';
import { record, text, list } from './user-interaction-fields';
export const mediaMissing = () =>
  new SessionError(404, 'media_missing', '这张原生图片当前不可读取，可能已移除或格式不受支持。');
export type NativeMedia = { data: Buffer; mimeType: string };
export function mediaReference(
  sessionId: string,
  messageId: string,
  index: number,
  options: { kind: 'user' | 'tool'; mimeType?: string },
): MessageAttachment {
  const { kind, mimeType } = options;
  return {
    kind: 'native-image',
    name: kind === 'user' ? `图片 ${index + 1}` : `工具图片 ${index + 1}`,
    mimeType,
    locator: { sessionId, messageId, index, kind },
  };
}
export function verifiedImage(data: Buffer, mimeType?: string): NativeMedia {
  if (data.length > ATTACHMENT_LIMITS.fileBytes) throw mediaMissing();
  const info = imageInfo(data);
  if (!info || (mimeType && info.mimeType !== mimeType)) throw mediaMissing();
  return { data, mimeType: info.mimeType };
}
export function base64Image(value: unknown, mimeType?: string): NativeMedia {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw mediaMissing();
  const data = Buffer.from(value, 'base64');
  if (data.toString('base64') !== value) throw mediaMissing();
  return verifiedImage(data, mimeType);
}
export async function imageSource(value: unknown): Promise<NativeMedia> {
  const block = record(value),
    source = record(block.source);
  if (source.type === 'base64') return base64Image(source.data, text(source.media_type));
  if (block.type === 'image' && typeof block.data === 'string') return base64Image(block.data, text(block.mimeType));
  if (block.inlineData) return base64Image(block.inlineData, text(block.mimeType));
  const url = text(block.url) || text(source.url);
  if (url) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match) throw mediaMissing();
    return base64Image(match[2], match[1]);
  }
  return localImage(block);
}
export function claudeMediaRefs(message: unknown, sessionId: string): MessageAttachment[] {
  const outer = record(message),
    inner = record(outer.message);
  const id = text(outer.uuid);
  if (!id) return [];
  return list(inner.content).flatMap((value, index) => {
    const block = record(value);
    return block.type === 'image'
      ? [
          mediaReference(sessionId, id, index, {
            kind: 'user',
            mimeType: text(record(block.source).media_type) || undefined,
          }),
        ]
      : [];
  });
}
export function claudeToolMedia(block: Record<string, unknown>, sessionId: string) {
  const attachments = list(block.content).flatMap((value, index) =>
    record(value).type === 'image'
      ? [
          mediaReference(sessionId, text(block.tool_use_id), index, {
            kind: 'tool',
            mimeType: text(record(record(value).source).media_type) || undefined,
          }),
        ]
      : [],
  );
  return attachments.length ? { attachments } : {};
}
export function claudeMediaBlock(messages: unknown[], locator: NativeMediaLocator): unknown {
  for (const message of messages) {
    const outer = record(message);
    const blocks = list(record(outer.message).content);
    if (locator.kind === 'user' && outer.type === 'user' && outer.uuid === locator.messageId)
      return blocks[locator.index];
    if (locator.kind === 'tool')
      for (const value of blocks) {
        const block = record(value);
        if (block.type === 'tool_result' && block.tool_use_id === locator.messageId)
          return list(block.content)[locator.index];
      }
  }
  throw mediaMissing();
}

async function localImage(block: Record<string, unknown>): Promise<NativeMedia> {
  const local = text(block.path) || text(block.uri);
  if (!local) throw mediaMissing();
  const file = local.startsWith('file:') ? fileURLToPath(local) : local;
  if (!path.isAbsolute(file)) throw mediaMissing();
  return verifiedImage(await readBoundedFile(file, ATTACHMENT_LIMITS.fileBytes));
}
