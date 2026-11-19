import type { McpRuntimeRegistry } from '../../../native-management/mcp/mcp-runtime';
export type CodexRuntimeOptions = {
  mcpRegistry?: McpRuntimeRegistry;
  command?: string | { command: string; args?: string[] };
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  experimentalApi?: boolean;
};

export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RecordValue) : {};
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export type RpcId = string | number;
export type ServerRequest = { id: RpcId; method: string; params: RecordValue };

/** 原生诊断可能含 URL、密钥或配置片段，只向上层暴露固定分类。 */
export class CodexError extends Error {
  constructor(
    message: string,
    readonly nativeRejected = false,
    readonly methodNotFound = false,
  ) {
    super(message);
    this.name = 'CodexError';
  }
}
/** 传输预算失效会结束当前客户端；只读历史可重建客户端并改读更小窗口。 */
export class CodexRpcLimit extends CodexError {
  constructor() {
    super('Codex 返回内容超过 8 MiB，无法完整读取。');
  }
}
export function safeError(error: unknown): string {
  return error instanceof CodexError ? error.message : 'Codex 运行失败，请检查本机运行时与配置。';
}
export function cancelled(): CodexError {
  return new CodexError('Codex 操作已取消。');
}
