import { NativeResourceError, resourceError } from '../agents/common/configuration/errors';

const messages = {
  unsupported_action: '此资源不支持该操作，请使用原生入口管理。',
  confirmation_required: '删除会移除整个技能目录，请确认技能名称后重试。',
  native_unavailable: '无法核实原生技能状态，请刷新或使用原生配置入口。',
  result_unconfirmed: '原生配置可能已更新，但尚未确认生效；请刷新后核对，不要重复操作。',
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
