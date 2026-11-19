import { z } from 'zod';
import { AgentKindSchema } from '../agents';

/** 省略表示沿用原生配置；各 CLI 的模式不互相转换。 */
export const PermissionSelectionSchema = z.discriminatedUnion('agent', [
  z.strictObject({
    agent: z.literal('claude'),
    mode: z.enum(['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']),
  }),
  z.strictObject({ agent: z.literal('codex'), mode: z.enum(['native', 'ask', 'auto-review', 'full-access']) }),
  z.strictObject({ agent: z.literal('antigravity'), mode: z.enum(['accept-edits', 'auto', 'plan', 'bypass']) }),
]);
export type PermissionSelection = z.infer<typeof PermissionSelectionSchema>;

/** 工作台会话权限覆盖；null 表示移除工作台记录并恢复原生默认。 */
export const SessionPermissionInputSchema = z.strictObject({
  permission: PermissionSelectionSchema.nullable(),
});
export type SessionPermissionDocument = z.infer<typeof SessionPermissionInputSchema>;

/** Codex 的 native 是已有线程的重置动作，不是新建线程的权限档位。 */
export function permissionForNewSession(selection?: PermissionSelection | null): PermissionSelection | undefined {
  return selection?.mode === 'native' ? undefined : (selection ?? undefined);
}

export const SessionPermissionDefaultsSchema = z
  .partialRecord(AgentKindSchema, PermissionSelectionSchema)
  .refine((defaults) =>
    Object.entries(defaults).every(
      ([agent, selection]) => selection?.agent === agent && !!permissionForNewSession(selection),
    ),
  );
export type SessionPermissionDefaults = z.infer<typeof SessionPermissionDefaultsSchema>;
