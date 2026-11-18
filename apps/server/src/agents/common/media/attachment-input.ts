import { pathToFileURL } from 'node:url';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTurnInput, NativeAttachment } from '../../contracts';
export function fileReference(attachment: NativeAttachment): string {
  return `文件附件：${attachment.name}\n本机文件引用：${JSON.stringify(attachment.path)}`;
}
export function claudeInput(text: string, attachments: NativeAttachment[] = []): SDKUserMessage['message']['content'] {
  if (!attachments.length) return text;
  const content: Exclude<SDKUserMessage['message']['content'], string> = text ? [{ type: 'text', text }] : [];
  for (const file of attachments) {
    if (file.kind === 'image')
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data: file.data.toString('base64'),
        },
      });
    else if (file.kind === 'pdf')
      content.push({
        type: 'document',
        title: file.name,
        source: { type: 'base64', media_type: 'application/pdf', data: file.data.toString('base64') },
      });
    else if (file.kind === 'text')
      content.push({
        type: 'document',
        title: file.name,
        source: { type: 'text', media_type: 'text/plain', data: file.data.toString('utf8') },
      });
    else content.push({ type: 'text', text: fileReference(file) });
  }
  return content;
}
export function codexAttachments(attachments: NativeAttachment[] = []): Record<string, unknown>[] {
  return attachments.map((file) =>
    file.kind === 'image'
      ? { type: 'image', url: `data:${file.mimeType};base64,${file.data.toString('base64')}` }
      : { type: 'text', text: fileReference(file), text_elements: [] },
  );
}
export function acpInput(text: string, attachments: NativeAttachment[] = []): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = text ? [{ type: 'text', text }] : [];
  for (const file of attachments) {
    if (file.kind === 'image')
      content.push({ type: 'image', mimeType: file.mimeType, data: file.data.toString('base64') });
    else if (file.kind === 'text')
      content.push({
        type: 'resource',
        resource: { uri: pathToFileURL(file.path).href, mimeType: 'text/plain', text: file.data.toString('utf8') },
      });
    else content.push({ type: 'text', text: fileReference(file) });
  }
  return content;
}
/** 原生已确认本轮完成后才释放自持久资产；记录失败保留固定缓存，不把成功回复改成失败。 */
export async function markEmbedded(input: AgentTurnInput, kinds: NativeAttachment['kind'][]): Promise<void> {
  const ids = input.attachments?.filter((file) => kinds.includes(file.kind)).map((file) => file.id);
  if (!ids?.length) return;
  try {
    await input.attachmentsStored?.(ids);
  } catch {
    /* 缓存仍保持pinned，可安全续聊。 */
  }
}
