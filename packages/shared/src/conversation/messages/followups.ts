import { z } from 'zod';
import { AgentKindSchema, NativeSessionIdSchema } from '../agents';
import { AttachmentRefSchema } from './attachments';
import { CapabilitySelectionSchema } from '../capabilities/capabilities';
import { PermissionSelectionSchema } from './permissions';
import { InteractionSpecSchema } from './interaction';

export const FOLLOWUP_LIMITS = {
  perConversation: 10,
  totalPending: 100,
  ownerReceipts: 1000,
  receiptMs: 30 * 60_000,
} as const;
export const FollowupContentSchema = z
  .strictObject({
    text: z.string().max(65_536),
    attachments: z.array(AttachmentRefSchema).max(8).optional(),
    selection: CapabilitySelectionSchema.optional(),
    model: z.string().min(1).max(256).optional(),
    reasoningEffort: z.string().min(1).max(40).optional(),
    collaborationMode: z.enum(['default', 'plan']).optional(),
    permission: PermissionSelectionSchema.optional(),
  })
  .refine((input) => !!input.text.trim() || !!input.attachments?.length || !!input.selection, {
    message: '请输入内容或添加附件',
  })
  .refine((input) => new TextEncoder().encode(JSON.stringify(input)).byteLength <= 65_536, {
    message: '追加消息内容不能超过64KiB',
  });
export type FollowupContent = z.infer<typeof FollowupContentSchema>;
export type FollowupMode = 'queue' | 'steer';
export type FollowupStatus = 'queued' | 'dispatching' | 'accepted' | 'unknown' | 'failed' | 'cancelled';
export const FollowupContextSchema = z.strictObject({
  queueId: z.uuid(),
  workspaceId: z.string().min(1),
  agent: AgentKindSchema,
  conversationId: z.string().min(1).max(200),
  sessionId: NativeSessionIdSchema.optional(),
});
export type FollowupContext = z.infer<typeof FollowupContextSchema>;
export type FollowupItem = {
  clientMessageId: string;
  revision: number;
  mode: FollowupMode;
  status: FollowupStatus;
  returnedToDraft?: true;
  text: string;
  content?: FollowupContent;
  reason?: string;
  turnId?: string;
};
export type FollowupSnapshot = FollowupContext & {
  revision: number;
  paused: boolean;
  reason?: string;
  items: FollowupItem[];
  activeTurnId?: string;
  canSteer?: boolean;
  questions?: AsyncQuestionState[];
};
export const AsyncQuestionSchema = z.strictObject({
  sessionId: NativeSessionIdSchema,
  messageId: z.string().min(1).max(512),
  spec: InteractionSpecSchema.options[0].extend({ blocking: z.literal(false) }),
});
export type AsyncQuestion = z.infer<typeof AsyncQuestionSchema>;
export type AsyncQuestionState = {
  question: AsyncQuestion;
  status: 'open' | FollowupStatus;
  clientMessageId?: string;
};
