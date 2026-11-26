import { z } from 'zod';
import { AGENT_KINDS, AgentKindSchema } from '../conversation/agents';

export const SpotlightSettingsSchema = z.strictObject({
  enabled: z.boolean(),
});
export type SpotlightSettings = z.infer<typeof SpotlightSettingsSchema>;
export const DEFAULT_SPOTLIGHT: SpotlightSettings = {
  enabled: true,
};

export const ConversationWidthPresetSchema = z.enum(['small', 'medium', 'large', 'custom']);
/** 三档预设的像素宽度；自定义值单独存在 width.custom。 */
export const CONVERSATION_WIDTHS = { small: 720, medium: 860, large: 1040 } as const;
export const AppearanceSettingsSchema = z.strictObject({
  /** 侧栏每个项目默认展开的会话行数。 */
  sessionLimit: z.number().int().min(1).max(20).default(5),
  width: z
    .strictObject({
      preset: ConversationWidthPresetSchema.default('medium'),
      custom: z.number().int().min(480).max(1400).default(860),
    })
    .default({ preset: 'medium', custom: 860 }),
});
export type AppearanceSettings = z.infer<typeof AppearanceSettingsSchema>;
export const DEFAULT_APPEARANCE: AppearanceSettings = { sessionLimit: 5, width: { preset: 'medium', custom: 860 } };
export const conversationWidth = (width: AppearanceSettings['width']): number =>
  width.preset === 'custom' ? width.custom : CONVERSATION_WIDTHS[width.preset];

// 旧的 antigravity 键仍能读回，但不能推断属于哪一种连接。
const ModelVisibilityKeySchema = z.enum([...AGENT_KINDS, 'codex-account', 'antigravity-account', 'antigravity-gemini']);
export type ModelVisibilityKey = z.infer<typeof ModelVisibilityKeySchema>;

export const KeyboardShortcutActionSchema = z.enum([
  'search',
  'newSession',
  'nextTab',
  'previousTab',
  'closeTab',
  'focusComposer',
  'settings',
  'sidebar',
]);
export type KeyboardShortcutAction = z.infer<typeof KeyboardShortcutActionSchema>;
export const KeyboardShortcutsSchema = z.partialRecord(
  KeyboardShortcutActionSchema,
  z.string().min(1).max(64).nullable(),
);

export const ProductSettingsSchema = z.strictObject({
  /** 工作区展开状态保存在工作台配置中，不随桌面页面端口变化。 */
  workspaceExpansion: z.record(z.string().min(1).max(200), z.boolean()).optional(),
  /** 全局工作台快捷键；缺省项沿用默认，null 表示停用。 */
  shortcuts: KeyboardShortcutsSchema.optional(),
  defaultAgent: AgentKindSchema.default('claude'),
  spotlight: SpotlightSettingsSchema.default(DEFAULT_SPOTLIGHT),
  appearance: AppearanceSettingsSchema.default(DEFAULT_APPEARANCE),
  /** 未配置时展示目录，显式空数组只保留当前会话的型号。 */
  modelVisibility: z
    .partialRecord(
      ModelVisibilityKeySchema,
      z
        .array(
          z
            .string()
            .trim()
            .min(1)
            .max(500)
            .regex(/^[^\r\n\0]+$/),
        )
        .max(10000),
    )
    .optional(),
  resources: z
    .strictObject({
      intervalSeconds: z.number().int().min(2).max(60).default(5),
      timeoutSeconds: z.number().int().min(2).max(30).default(8),
    })
    .default({ intervalSeconds: 5, timeoutSeconds: 8 }),
});
export type ProductSettings = z.infer<typeof ProductSettingsSchema>;
export type ProductSettingsDocument = { settings: ProductSettings; revision: string };
export const ProductSettingsInputSchema = z.strictObject({
  settings: ProductSettingsSchema,
  revision: z.string().regex(/^(missing|[a-f0-9]{64})$/),
});
export type ProductSettingsInput = z.infer<typeof ProductSettingsInputSchema>;
export const WorkspaceExpansionInputSchema = z.strictObject({
  workspaceId: z.string().min(1).max(200),
  expanded: z.boolean(),
});
export type WorkspaceExpansionInput = z.infer<typeof WorkspaceExpansionInputSchema>;
/** 环境面板只显示三个 Agent 的第一层探测结果；同步与本地 git 域删除后不再检测 git/rclone。 */
export type EnvironmentTool = {
  name: 'Claude Code' | 'Codex' | 'Antigravity';
  available: boolean;
  version: string | null;
  message: string | null;
};
export type EnvironmentReport = { checkedAt: number; tools: EnvironmentTool[] };
