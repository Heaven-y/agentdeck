export type AcpRecord = Record<string, unknown>;
export type AcpId = string | number;
export type AcpRequest = { id: AcpId; method: string; params: AcpRecord };
export type AcpCallOptions = { signal?: AbortSignal; timeoutMs?: number };
export type AcpConnection = {
  closed: Promise<void>;
  onNotification(method: string, params: AcpRecord): void;
  onRequest(request: AcpRequest): void;
  request(method: string, params: AcpRecord, options?: AcpCallOptions): Promise<AcpRecord>;
  notify(method: string, params: AcpRecord): void;
  respond(id: AcpId, result: AcpRecord): void;
  reject(id: AcpId): void;
  close(): Promise<void>;
};
export const object = (value: unknown): AcpRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as AcpRecord) : {};
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export class AcpError extends Error {
  constructor(
    readonly code: 'unavailable' | 'selection' | 'cancelled' | 'protocol' | 'native',
    message: string,
  ) {
    super(message);
  }
}
export const cancelled = () => new AcpError('cancelled', '本轮已中断。');
export const protocolFailure = () => new AcpError('protocol', 'Antigravity ACP 返回了无法确认的协议数据，已停止本轮。');
