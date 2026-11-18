import { z } from 'zod';

/** 产品支持的 CLI 及默认展示顺序，由协议与各入口共同使用。 */
export const AGENT_KINDS = ['claude', 'codex', 'antigravity'] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export const isAgentKind = (value: unknown): value is AgentKind => AgentKindSchema.safeParse(value).success;
export const NativeSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
/** 只接收原生轮次/消息 ID，不接收文件路径或其他原生参数覆盖。 */
export const SessionForkSchema = z.object({ pointId: NativeSessionIdSchema.optional() }).strict();
export type SessionForkInput = z.infer<typeof SessionForkSchema>;
export const SessionActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), title: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal('delete'), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('archive') }).strict(),
  z.object({ action: z.literal('unarchive') }).strict(),
]);
export type SessionActionInput = z.infer<typeof SessionActionSchema>;
export type AgentKind = z.infer<typeof AgentKindSchema>;
