import http from 'node:http';
import { SessionError } from '../../errors';

export type ManagementRecord = Record<string, unknown>;
export type ManagementMethod =
  | 'GetAvailableModels'
  | 'GetMendelFlags'
  | 'GetUserStatus'
  | 'GetAllSkills'
  | 'GetAgentScripts'
  | 'GetCascadeTrajectory'
  | 'GetCascadeTrajectorySteps'
  | 'GetConversationMetadata'
  | 'GetCascadeTrajectoryGeneratorMetadata'
  | 'ForkConversation'
  | 'DeleteCascadeTrajectory'
  | 'JetboxDeleteSummary'
  | 'UpdateConversationAnnotations';
export type ManagementBudget = 'history' | 'page';
export type ManagementBackend = {
  request(method: ManagementMethod, params: ManagementRecord, budget?: ManagementBudget): Promise<ManagementRecord>;
  readInitialUpdate?(params: ManagementRecord): Promise<ManagementRecord>;
  close(): Promise<void>;
};
export const managementObject = (value: unknown): ManagementRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ManagementRecord) : {};
export const managementText = (value: unknown) => (typeof value === 'string' ? value : '');
export const managementFailure = () => new SessionError(503, 'session_runtime_failed', 'Antigravity 操作失败。');
const MIB = 1024 * 1024;
export const managementByteLimit = (budget?: ManagementBudget) =>
  budget === 'history' ? Infinity : (budget === 'page' ? 4 : 32) * MIB;

export class NativeTrajectoryMissing extends SessionError {
  constructor() {
    super(404, 'session_missing', 'Antigravity 原生会话不存在。');
  }
}

function trajectoryMissing(method: ManagementMethod, body: Buffer): boolean {
  if (method !== 'GetCascadeTrajectory') return false;
  try {
    return managementObject(JSON.parse(body.toString('utf8'))).code === 'not_found';
  } catch {
    return false;
  }
}

/** 只连接当前管理子进程报告的回环端口；不跟随重定向，也不回传原始诊断。 */
export function managementRequest(
  port: number,
  method: ManagementMethod,
  params: ManagementRecord,
  { signal, budget }: { signal?: AbortSignal; budget?: ManagementBudget } = {},
): Promise<ManagementRecord> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(params));
    const request = http.request({
      hostname: '127.0.0.1',
      signal,
      port,
      method: 'POST',
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    });
    const timer = setTimeout(() => request.destroy(managementFailure()), 15_000);
    const finish = (error?: Error, value?: ManagementRecord) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    request.once('error', () => finish(managementFailure()));
    request.once('response', (response) => {
      const code = response.statusCode ?? 500;
      const limit = managementByteLimit(budget);
      const exceeded = () => {
        finish(managementFailure());
        response.destroy();
      };
      if (Number(response.headers['content-length']) > limit) {
        exceeded();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) exceeded();
        else chunks.push(chunk);
      });
      response.once('error', () => finish(managementFailure()));
      response.once('end', () => {
        const body = Buffer.concat(chunks);
        if (code === 404) {
          finish(trajectoryMissing(method, body) ? new NativeTrajectoryMissing() : managementFailure());
          return;
        }
        if (code < 200 || code >= 300) {
          finish(managementFailure());
          return;
        }
        try {
          const value: unknown = JSON.parse(body.toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          finish(undefined, value as ManagementRecord);
        } catch {
          finish(managementFailure());
        }
      });
    });
    request.end(body);
  });
}
