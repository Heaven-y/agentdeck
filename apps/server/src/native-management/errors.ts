import { NativeResourceError, resourceError } from '../agents/common/configuration/errors';

const messages = {
  unsupported_action: '此操作暂不可用，请在 CLI 中管理。',
  confirmation_required: '删除会移除整个技能目录，请确认技能名称后重试。',
  native_unavailable: '资源状态读取失败，请刷新重试。',
  result_unconfirmed: '配置可能已保存，但尚未确认结果。请重新读取后再操作。',
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
