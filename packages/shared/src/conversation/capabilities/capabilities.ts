import { z } from 'zod';
import type { AgentKind } from '../agents';
import type { NativeInteractionFeatures } from './native-features';

export const CapabilitySelectionSchema = z.object({ id: z.string().min(1).max(100) }).strict();
export type CapabilitySelection = z.infer<typeof CapabilitySelectionSchema>;
export type AgentCapability = {
  id: string;
  kind: 'skill' | 'command';
  name: string;
  description: string;
  source?: string;
  aliases?: string[];
  argumentHint?: string;
  available: boolean;
  unavailableReason?: string;
  requiresSession: boolean;
  supportsArguments: boolean;
};
export type AgentModel = {
  id: string;
  label: string;
  description?: string;
  /** 底层原生模型 ID；id 可以是 CLI 别名或自定义配置键，不改写发送值。 */
  modelId?: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  /** 仅保留原生明确报告的输入类型；缺省表示未知，不能从名称推断。 */
  inputModalities?: string[];
};
export const AntigravityConnectionSchema = z.enum(['account', 'gemini']);
export type AntigravityConnection = z.infer<typeof AntigravityConnectionSchema>;

/** 只展示原生官方额度窗口，不含回合 token 或服务商账单。 */
export type OfficialUsage = {
  checkedAt: number;
  groups: Array<{
    name: string;
    buckets: Array<{ id: string; name: string; window?: string; remainingFraction?: number; resetAt?: string }>;
  }>;
};

export type AntigravityOfficialUsage = OfficialUsage;

export type AgentCapabilities = {
  agent: AgentKind;
  /** Antigravity 原生目录的连接身份，缺失时不套用任一模式的偏好。 */
  antigravityConnection?: AntigravityConnection;
  /** 仅本次发现确认原生 ChatGPT 登录时提供；未确认或自定义服务保持缺失。 */
  codexAccount?: true;
  /** 原生配置的默认选择；未知时省略，不以候选第一项代替。 */
  defaultModel?: string;
  defaultReasoningEffort?: string;
  /** false 表示尚未向 CLI 读取；缺省兼容已取得的目录。 */
  discovered?: boolean;
  /** 模型可从磁盘恢复；技能与命令须在本进程从相同目录重新发现。 */
  commandsDiscovered?: boolean;
  /** 旧缓存可省略；缺省不能开启新的原生交互。 */
  features?: NativeInteractionFeatures;
  /** 只在本进程从原生协商目录取得；旧缓存缺失时不可推断支持。 */
  collaborationModes?: Array<'default' | 'plan'>;
  entries: AgentCapability[];
  models: AgentModel[];
  warnings: string[];
  /** 分组反馈；空串代表模型正常，技能提示不能混进模型菜单。 */
  modelWarning?: string;
  commandWarnings?: string[];
};

/** 原生统计与原生估算均保留来源；有有效窗口时可计算最近报告的占比。 */
export type ContextUsage = {
  usedTokens: number;
  windowTokens?: number;
  percentage?: number;
  model?: string;
  source: 'claude_estimate' | 'codex_native' | 'antigravity_estimate';
};
export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  source: 'claude' | 'codex' | 'antigravity';
  /** 计数与耗时必须属于同一范围；步骤数据不能冒充整个回合。 */
  scope: 'turn' | 'step';
};
export type CompactionState = {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  trigger?: 'manual' | 'auto';
  beforeTokens?: number;
  afterTokens?: number;
  message?: string;
};
