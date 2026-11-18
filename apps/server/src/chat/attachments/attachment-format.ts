import path from 'node:path';
import { ATTACHMENT_LIMITS, type ChatAttachment } from '@agentdeck/shared/conversation';
import { imageInfo } from '../../agents/common/media/media-format';
import { SessionError } from '../../agents/errors';
export const attachmentError = (message: string, code = 'attachment_invalid') => new SessionError(400, code, message);
function validName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    ![...name].some((char) => char.charCodeAt(0) < 32) &&
    !/[\\/:*?"<>|]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}
function textFile(data: Buffer): boolean {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return ![...value].some((char) => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)));
  } catch {
    return false;
  }
}
export function attachmentFormat(input: {
  name: string;
  mimeType: string;
  data: Buffer;
}): Pick<ChatAttachment, 'kind' | 'mimeType' | 'name' | 'size'> {
  if (!validName(input.name) || !input.data.length || input.data.length > ATTACHMENT_LIMITS.fileBytes)
    throw attachmentError('附件名称或大小无效，每个文件最多5 MiB。');
  let image;
  try {
    image = imageInfo(input.data);
  } catch {
    throw attachmentError('图片格式或尺寸无效，请重新选择。');
  }
  const base = { name: input.name, size: input.data.length };
  if (image) {
    if (input.mimeType.startsWith('image/') && input.mimeType !== image.mimeType)
      throw attachmentError('图片声明类型与实际内容不一致。');
    return { ...base, kind: 'image', mimeType: image.mimeType };
  }
  return documentFormat(input, base);
}
function documentFormat(
  input: { mimeType: string; data: Buffer },
  base: { name: string; size: number },
): Pick<ChatAttachment, 'kind' | 'mimeType' | 'name' | 'size'> {
  if (input.mimeType.startsWith('image/')) throw attachmentError('文件内容不是支持的图片格式。');
  if (input.data.subarray(0, 5).toString('ascii') === '%PDF-')
    return { ...base, kind: 'pdf', mimeType: 'application/pdf' };
  if (input.mimeType === 'application/pdf') throw attachmentError('文件内容不是PDF。');
  if (textFile(input.data)) return { ...base, kind: 'text', mimeType: 'text/plain' };
  return { ...base, kind: 'file', mimeType: 'application/octet-stream' };
}
export function attachmentExtension(value: ChatAttachment): string {
  const fixed: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
  };
  if (fixed[value.mimeType]) return fixed[value.mimeType]!;
  const extension = path.extname(value.name);
  return /^\.[a-z0-9]{1,12}$/i.test(extension) ? extension : value.kind === 'text' ? '.txt' : '.bin';
}
