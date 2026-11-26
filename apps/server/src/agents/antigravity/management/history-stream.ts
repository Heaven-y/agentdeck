import http, { type IncomingMessage } from 'node:http';
import { SessionError } from '../../errors';
import { managementObject as object, NativeTrajectoryMissing, type ManagementRecord } from './management-rpc';

export class NativeHistoryPagingUnavailable extends SessionError {
  constructor() {
    super(501, 'session_history_paging_unavailable', '当前 Antigravity CLI 不支持原生历史分页。');
  }
}
export const historyPageIncomplete = () =>
  new SessionError(503, 'session_history_page_incomplete', 'Antigravity 原生历史页未完整返回，请重试。');

const HEADER = 5;

function decodeFrame(flags: number, content: Buffer): ManagementRecord {
  const frame = object(JSON.parse(content.toString('utf8')));
  if (flags === 2) {
    const { code } = object(frame.error);
    if (code === 'unimplemented') throw new NativeHistoryPagingUnavailable();
    if (code === 'not_found') throw new NativeTrajectoryMissing();
    throw historyPageIncomplete();
  }
  const result = object(frame.update);
  if (!Object.keys(result).length) throw historyPageIncomplete();
  return result;
}

/** 响应可能分块，也可能同一块带上后续实时更新；只保留一个按条数分页的初始帧。 */
class InitialFrame {
  private readonly header = Buffer.alloc(HEADER);
  private headerBytes = 0;
  private remaining: number | undefined;
  private readonly chunks: Buffer[] = [];
  push(chunk: Buffer): ManagementRecord | undefined {
    if (this.remaining === undefined) {
      const start = this.headerBytes;
      this.headerBytes += chunk.copy(this.header, start, 0, HEADER - start);
      if (this.headerBytes < HEADER) return;
      chunk = chunk.subarray(HEADER - start);
      if (this.header[0] !== 0 && this.header[0] !== 2) throw historyPageIncomplete();
      this.remaining = this.header.readUInt32BE(1);
    }
    this.chunks.push(chunk.subarray(0, this.remaining));
    this.remaining -= Math.min(chunk.length, this.remaining);
    if (this.remaining === 0) return decodeFrame(this.header[0]!, Buffer.concat(this.chunks));
  }
}

function checkResponse(response: IncomingMessage) {
  const content = response.headers['content-type']?.split(';', 1)[0];
  if (response.statusCode === 501 || (response.statusCode === 404 && content === 'text/plain'))
    throw new NativeHistoryPagingUnavailable();
  if (response.statusCode !== 200 || content !== 'application/connect+json') throw historyPageIncomplete();
}

/** 只连接已验证的原生子进程；不监听后续变更、不执行对话命令。 */
export function readInitialAgentUpdate(
  port: number,
  params: ManagementRecord,
  options: { signal?: AbortSignal } = {},
): Promise<ManagementRecord> {
  return new Promise((resolve, reject) => {
    const frame = new InitialFrame();
    const signal = AbortSignal.any([AbortSignal.timeout(7_000), ...(options.signal ? [options.signal] : [])]);
    const payload = Buffer.from(JSON.stringify(params));
    const header = Buffer.alloc(HEADER);
    header.writeUInt32BE(payload.length, 1);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      signal,
      method: 'POST',
      path: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
      headers: {
        'content-type': 'application/connect+json',
        'connect-protocol-version': '1',
        'content-length': header.length + payload.length,
      },
    });
    const fail = (error?: unknown) => reject(error instanceof SessionError ? error : historyPageIncomplete());
    request.once('error', fail);
    request.once('response', (response) => {
      response.once('error', fail);
      response.once('end', () => fail());
      try {
        checkResponse(response);
      } catch (error) {
        fail(error);
        response.destroy();
        return;
      }
      response.on('data', (chunk: Buffer) => {
        try {
          const result = frame.push(chunk);
          if (!result) return;
          resolve(result);
        } catch (error) {
          fail(error);
        }
        response.destroy();
      });
    });
    request.end(Buffer.concat([header, payload]));
  });
}
