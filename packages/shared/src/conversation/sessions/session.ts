import { z } from 'zod';
import { AgentKindSchema, type AgentKind } from '../agents';
import type { AgentEvent } from '../messages/events';

/** 本机探测的四种结果：可用、未安装、接口变化、凭据缺失。 */
export const ProbeStatusSchema = z.enum(['available', 'missing', 'changed', 'credential-missing']);
export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;

/** 只报告本机事实，不发模型请求：missing 列出缺失的能力（flag 或子命令）。 */
export const AgentProbeSchema = z.object({
  agent: AgentKindSchema,
  status: ProbeStatusSchema,
  version: z.string().min(1).optional(),
  missing: z.array(z.string().min(1)).optional(),
  message: z.string().min(1).optional(),
});
export type AgentProbe = z.infer<typeof AgentProbeSchema>;

/** 会话身份 = CLI + 该 CLI 自己的原生会话 id，不能跨 CLI 转换。 */
export type SessionRef = { agent: AgentKind; sessionId: string };

/** 会话动作由服务端按实际接入能力提供；工作台归档不修改 CLI 历史。 */
export const SessionCapabilitiesSchema = z.object({
  rename: z.boolean(),
  fork: z.literal('native').nullable(),
  delete: z.literal('native').nullable(),
  archive: z.enum(['native', 'workbench']).nullable(),
});
export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;
/** 项目会话列表的一行；projectId 为 null 表示不属于任何已配置项目。 */
export const SessionSummarySchema = z.object({
  agent: AgentKindSchema,
  sessionId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  title: z.string(),
  updatedAt: z.string().min(1),
  running: z.boolean(),
  /** 原生元数据中可确定的本机绝对目录，供用户显式添加项目；未知或多目录不填写。 */
  directory: z.string().min(1).optional(),
  capabilities: SessionCapabilitiesSchema.optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** 页面只取得一段摘要；nextCursor 表示仍可继续加载，空页不代表已到末尾。 */
export const SessionPageQuerySchema = z
  .object({
    agent: AgentKindSchema,
    scope: z.enum(['active', 'archived', 'unassigned']).default('active'),
    projectId: z.string().min(1).max(200).optional(),
    reader: z.string().min(1).max(100).optional(),
    search: z.string().max(200).optional(),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();
export type SessionPageQuery = z.infer<typeof SessionPageQuerySchema>;
export type SessionPage = { items: SessionSummary[]; nextCursor?: string };

/** 各 CLI 原生存储里的会话行：只有原生元数据，不含项目归属与运行态。 */
export type SessionRecord = SessionRef & {
  summary: string;
  lastModified: number;
  /** 原生会话记录的模型配置，不代表逐轮执行遥测。 */
  nativeModel?: string;
};
export type SessionHistory = { session: SessionRecord; events: AgentEvent[]; actualModel?: string };

export const SessionHistoryPageQuerySchema = z.strictObject({
  before: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
/** start 按从旧到新递增：AGY 是原生步骤索引，Codex 是相对首屏的页位置。无游标表示已到开头。 */
export type SessionHistoryPageInfo = {
  start: number;
  before?: string;
  /** 与相邻页共同构成一轮；sameFragment 表示整页不含新的用户轮头。 */
  leading?: HistoryTurnFragment;
  trailing?: HistoryTurnFragment;
  sameFragment?: boolean;
};
export type HistoryTurnFailure = {
  message: string;
  retryOnly?: true;
  /** 轮尾已经输出这条明确的错误，拼齐时不再追加。 */
  shownAtTail?: true;
};

/** 单纯重试提示不能覆盖同轮明确的失败；同一等级取后出现的原生原因。 */
export function preferHistoryTurnFailure(
  older?: HistoryTurnFailure,
  newer?: HistoryTurnFailure,
): HistoryTurnFailure | undefined {
  return older && !older.retryOnly && newer?.retryOnly ? older : (newer ?? older);
}

export function historyTurnFailureMessage(turn: HistoryTurnFragment): string | undefined {
  const recovered = turn.failure?.retryOnly && turn.retryRecovered && !turn.failed && !turn.cancelled && !turn.omitted;
  return recovered ? undefined : turn.failure?.message;
}

export type HistoryTurnFragment = {
  failed: boolean;
  /** 本片段最后一次明确取消或恢复；未提供表示不改变较早片段的状态。 */
  cancelled?: boolean;
  omitted: boolean;
  /** 此片段结束于空回复；拼齐整轮且没有更早正文时才显示。 */
  emptyReplyMessage?: string;
  failure?: HistoryTurnFailure;
  /** 已见步骤均完成；有轮尾时，最后一步是完整答复。跨页还要核对其余片段。 */
  retryRecovered?: true;
  forkPoint?: string;
};
export type SessionHistoryPage = SessionHistory & { page?: SessionHistoryPageInfo };
