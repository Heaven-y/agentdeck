import { z } from 'zod';
import { AgentKindSchema, NativeSessionIdSchema } from '../agents';
export const ATTACHMENT_LIMITS = {
  count: 8,
  images: 4,
  fileBytes: 5 * 1024 * 1024,
  messageBytes: 20 * 1024 * 1024,
  cacheBytes: 256 * 1024 * 1024,
  maxDimension: 16384,
  maxPixels: 32 * 1024 * 1024,
} as const;
export const AttachmentRefSchema = z.strictObject({ id: z.uuid(), revision: z.string().regex(/^[a-f0-9]{64}$/) });
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
export const ChatAttachmentSchema = AttachmentRefSchema.extend({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  size: z.number().int().positive().max(ATTACHMENT_LIMITS.fileBytes),
  kind: z.enum(['image', 'text', 'pdf', 'file']),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;
export const AttachmentScopeSchema = z.strictObject({
  workspaceId: z.string().min(1).max(200),
  agent: AgentKindSchema,
  conversationId: z.string().min(1).max(200),
  sessionId: NativeSessionIdSchema.optional(),
});
export type AttachmentScope = z.infer<typeof AttachmentScopeSchema>;
/** 历史定位仅由原生消息身份构成；网页不能指定本机路径或远程URL。 */
export type NativeMediaLocator = {
  sessionId: string;
  subagentId?: string;
  messageId: string;
  index: number;
  kind: 'user' | 'tool';
};
export type MessageAttachment =
  ChatAttachment | { kind: 'native-image'; name: string; mimeType?: string; locator: NativeMediaLocator };
