import { NativeResourceError, resourceError } from '../agents/common/configuration/errors';

const messages = {
  unsupported_action: '当前配置不支持此操作。',
  confirmation_required: '删除会移除整个技能目录，请确认技能名称后重试。',
  native_unavailable: '资源状态读取失败，请刷新重试。',
  skill_state_unconfirmed: '未读到预期的技能状态。请重新读取技能目录。',
  skill_delete_incomplete: '删除未完成。请检查技能上级目录中是否有以 .deleted- 开头的文件夹。',
  mcp_change_unconfirmed: '未读到预期的 MCP 配置。请重新读取 MCP 列表。',
} as const;
export class NativeManagementError extends Error {
  readonly status = 409;
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
export function managementError(error: unknown) {
  if (error instanceof NativeManagementError || error instanceof NativeResourceError) return error;
  return resourceError(error);
}
