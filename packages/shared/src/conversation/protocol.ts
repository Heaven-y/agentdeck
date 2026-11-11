import { z } from 'zod';
import { AgentKindSchema, NativeSessionIdSchema, type AgentKind } from './agents';
import { CapabilitySelectionSchema } from './capabilities';
import type { AgentEvent } from './events';
import { PermissionSelectionSchema } from './permissions';
import { InteractionAnswerSchema, type InteractionEvent } from './interaction';
import { AttachmentRefSchema, type ChatAttachment } from './attachments';
import { FollowupContentSchema, type FollowupSnapshot } from './followups';
import type { RuntimeTasksState } from './runtime-tasks';

const ClaudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

// 前端 → 后端的 WebSocket 消息，后端用 schema 校验
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('task.stop'),
    workspaceId: z.string().min(1),
    agent: AgentKindSchema,
    sessionId: NativeSessionIdSchema,
    runtimeId: z.uuid(),
    taskId: z.string().min(1).max(200),
  }),
  z.strictObject({
    type: z.literal('question.respond'),
    collaborationMode: z.enum(['default', 'plan']).optional(),
    workspaceId: z.string().min(1),
    agent: z.literal('codex'),
    sessionId: NativeSessionIdSchema,
    conversationId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(512),
    answer: InteractionAnswerSchema,
    model: z.string().min(1).max(256).optional(),
    reasoningEffort: z.string().min(1).max(40).optional(),
    permission: PermissionSelectionSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('chat.followup'),
    queueId: z.uuid(),
    clientMessageId: z.uuid(),
    mode: z.enum(['queue', 'steer']),
    turnId: z.string().min(1).optional(),
    content: FollowupContentSchema,
  }),
  z.strictObject({
    type: z.literal('followup.edit'),
    queueId: z.uuid(),
    clientMessageId: z.uuid(),
    revision: z.number().int().nonnegative(),
    content: FollowupContentSchema,
  }),
  z.strictObject({
    type: z.literal('followup.cancel'),
    queueId: z.uuid(),
    clientMessageId: z.uuid(),
    revision: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal('followup.clear'), queueId: z.uuid() }),
  z.strictObject({ type: z.literal('followup.resume'), queueId: z.uuid() }),
  z.strictObject({ type: z.literal('interaction.respond'), id: z.uuid(), answer: InteractionAnswerSchema }),
  z
    .object({
      type: z.literal('chat.send'),
      collaborationMode: z.enum(['default', 'plan']).optional(),
      workspaceId: z.string().min(1),
      agent: AgentKindSchema,
      /** 继续已有会话时传入 */
      sessionId: NativeSessionIdSchema.optional(),
      text: z.string(),
      attachments: z.array(AttachmentRefSchema).max(8).optional(),
      selection: CapabilitySelectionSchema.optional(),
      /** 不传表示跟随本地配置 */
      model: z.string().min(1).optional(),
      /** 下轮推理强度；Claude 映射 SDK effort，实际支持由原生运行时决定；不传沿用原生配置。 */
      reasoningEffort: z.string().min(1).max(40).optional(),
      permission: PermissionSelectionSchema.optional(),
      /** 前端生成，用于把 turn.started 与本次发送对应起来 */
      clientTurnId: z.string().min(1),
      /** 仅用于刷新后重建本网页的会话分组，后端不据此授权操作。 */
      conversationId: z.string().min(1).max(200).optional(),
    })
    .refine((message) => message.text.trim().length > 0 || !!message.selection || !!message.attachments?.length, {
      message: '请输入消息或选择技能与命令',
    })
    .refine((message) => !message.permission || message.permission.agent === message.agent, {
      path: ['permission'],
      message: '权限模式不属于当前 CLI',
    })
    .refine((message) => !message.collaborationMode || message.agent === 'codex', { message: '协作模式仅用于Codex' })
    .refine(
      (message) =>
        message.agent !== 'claude' ||
        message.reasoningEffort === undefined ||
        ClaudeEffortSchema.safeParse(message.reasoningEffort).success,
      {
        path: ['reasoningEffort'],
        message: 'Claude 推理强度必须是 low、medium、high、xhigh 或 max',
      },
    ),
  z.object({
    type: z.literal('chat.interrupt'),
    turnId: z.string().min(1),
  }),
  z.object({
    type: z.literal('permission.respond'),
    turnId: z.string().min(1),
    requestId: z.string().min(1),
    allow: z.boolean(),
    message: z.string().optional(),
  }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// 后端 → 前端的 WebSocket 消息
export type ServerMessage =
  | { type: 'task.error'; runtimeId: string; taskId: string; message: string }
  | { type: 'tasks.state'; state: RuntimeTasksState }
  | {
      type: 'followup.delivered';
      queueId: string;
      clientMessageId: string;
      turnId: string;
      workspaceId: string;
      agent: AgentKind;
      conversationId: string;
      sessionId?: string;
      text: string;
      attachments?: ChatAttachment[];
    }
  | {
      type: 'question.error';
      workspaceId: string;
      agent: AgentKind;
      sessionId: string;
      messageId: string;
      message: string;
    }
  | { type: 'followup.state'; snapshot: FollowupSnapshot }
  | { type: 'followup.error'; queueId: string; clientMessageId?: string; message: string }
  | { type: 'input.rejected'; turnId: string; message: string }
  | {
      type: 'interaction.event';
      workspaceId: string;
      agent: AgentKind;
      sessionId?: string;
      turnId?: string;
      event: InteractionEvent;
    }
  | {
      type: 'turn.started';
      turnId: string;
      clientTurnId: string;
      workspaceId: string;
      agent: AgentKind;
      queueId?: string;
      followupClientMessageId?: string;
      input?: Extract<ClientMessage, { type: 'chat.send' }>;
    }
  | { type: 'agent.event'; turnId: string; event: AgentEvent }
  | { type: 'turn.finished'; turnId: string; workspaceId: string; agent: AgentKind }
  | { type: 'error'; turnId?: string; clientTurnId?: string; message: string };
