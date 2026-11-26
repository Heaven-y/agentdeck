import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { resolveLocalCommand, type ResolvedCommand } from '../../../platform/process/executable';
import { AntigravityLines } from '../run/lines';
import { antigravityBackgroundEnvironment } from '../run/process-environment';
import { antigravityDiagnostic } from '../run/diagnostics';
import {
  AcpError,
  cancelled,
  object,
  text,
  protocolFailure,
  type AcpConnection,
  type AcpRecord,
  type AcpId,
  type AcpCallOptions,
  type AcpRequest,
} from './types';

const METHODS = new Set([
  'initialize',
  'authenticate',
  'session/new',
  'session/resume',
  'session/load',
  'session/close',
  'session/list',
  'session/set_config_option',
  'session/prompt',
]);
type Pending = { resolve(value: AcpRecord): void; reject(error: Error): void; timer?: NodeJS.Timeout; cleanup(): void };
export type AcpLaunchOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  bypass?: boolean;
  command?: ResolvedCommand;
  mainAgent?: string;
};

function nativeFailure(value: unknown): AcpError {
  const error = object(value);
  if (error.code === -32601) return new AcpError('unavailable', '当前 Antigravity 版本不支持此操作。');
  const diagnostic = antigravityDiagnostic(text(error.message));
  return new AcpError('native', diagnostic?.type === 'error' ? diagnostic.message : 'AGY 没有完成请求。');
}

/** 只传固定ACP方法；原生诊断和未知远端请求不能成为宿主命令入口。 */
export class AntigravityAcpClient implements AcpConnection {
  readonly closed: Promise<void>;
  onNotification: (method: string, params: AcpRecord) => void = () => {};
  onRequest: (request: AcpRequest) => void = (request) => this.reject(request.id);
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<AcpId, Pending>();
  private readonly lines = new AntigravityLines((line) => this.receive(line), 8 * 1024 * 1024);
  private nextId = 0;
  private stopped = false;
  private closing?: Promise<void>;

  constructor(options: AcpLaunchOptions) {
    const env = antigravityBackgroundEnvironment(options.env ?? process.env);
    const executable = options.command ?? resolveLocalCommand('agy', env);
    const args = [...executable.args, 'acp', ...(options.bypass ? ['--dangerously-skip-permissions'] : [])];
    if (options.mainAgent) args.push('--agent', options.mainAgent);
    this.child = spawn(executable.command, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    });
    this.closed = new Promise((resolve) =>
      this.child.once('close', () => {
        try {
          this.lines.end();
        } catch {
          /* 退出已使未完成请求失败。 */
        }
        this.failAll(new AcpError('unavailable', 'Antigravity 连接已结束。'));
        resolve();
      }),
    );
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.lines.push(chunk);
      } catch {
        this.failAll(protocolFailure());
        void this.close();
      }
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.failAll(new AcpError('unavailable', 'Antigravity 连接已断开。')));
    this.child.once('error', () => this.failAll(new AcpError('unavailable', '无法启动 Antigravity。')));
  }

  static start(options: AcpLaunchOptions): Promise<AcpConnection> {
    return Promise.resolve(new AntigravityAcpClient(options));
  }

  request(method: string, params: AcpRecord, options: AcpCallOptions = {}): Promise<AcpRecord> {
    if (!METHODS.has(method) || this.stopped || this.pending.size >= 128) return Promise.reject(protocolFailure());
    if (options.signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const abort = () => this.settle(id, cancelled());
      const timeout = options.timeoutMs ?? 30_000;
      const timer =
        timeout > 0
          ? setTimeout(() => this.settle(id, new AcpError('native', 'Antigravity 响应超时。')), timeout)
          : undefined;
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: () => options.signal?.removeEventListener('abort', abort),
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method: string, params: AcpRecord): void {
    if (method !== 'session/cancel') throw protocolFailure();
    this.write({ jsonrpc: '2.0', method, params });
  }
  respond(id: AcpId, result: AcpRecord): void {
    this.write({ jsonrpc: '2.0', id, result });
  }
  reject(id: AcpId): void {
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: '当前客户端不支持此请求' } });
  }
  ownsRequest(id: AcpId): boolean {
    return this.pending.has(id);
  }

  private write(value: unknown): void {
    if (this.stopped || this.child.stdin.destroyed) return;
    const data = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) {
      this.failAll(protocolFailure());
      void this.close();
      return;
    }
    this.child.stdin.write(data);
  }
  private receive(line: string): void {
    const message = object(JSON.parse(line));
    if (message.jsonrpc !== '2.0') throw protocolFailure();
    const id = message.id;
    const validId = typeof id === 'string' || typeof id === 'number';
    if (typeof message.method === 'string') {
      if (validId) this.onRequest({ id, method: message.method, params: object(message.params) });
      else this.onNotification(message.method, object(message.params));
      return;
    }
    if (!validId) throw protocolFailure();
    this.receiveResult(id, message);
  }
  private receiveResult(id: AcpId, message: AcpRecord): void {
    if (message.error) {
      this.settle(id, nativeFailure(message.error));
    } else if (message.result && typeof message.result === 'object') this.settle(id, undefined, object(message.result));
    else throw protocolFailure();
  }
  private settle(id: AcpId, error?: Error, result: AcpRecord = {}): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (error) pending.reject(error);
    else pending.resolve(result);
  }
  private failAll(error: Error): void {
    this.stopped = true;
    for (const id of this.pending.keys()) this.settle(id, error);
  }
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    this.failAll(new AcpError('unavailable', 'Antigravity 连接已关闭。'));
    if (this.child.exitCode !== null || !this.child.pid) return this.closed;
    // 关闭ACP必须覆盖其原生后端，不能仅留下退出的stdio父进程。
    if (process.platform === 'win32') {
      const killer = spawn(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
        ['/PID', String(this.child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      const timer = setTimeout(() => {
        killer.kill();
        this.child.kill('SIGKILL');
      }, 5000);
      await new Promise<void>((resolve) => {
        killer.once('close', () => resolve());
        killer.once('error', () => resolve());
      });
      clearTimeout(timer);
    } else {
      try {
        process.kill(-this.child.pid, 'SIGKILL');
      } catch {
        /* 原生进程组可能已退出。 */
      }
    }
    this.child.kill('SIGKILL');
    await this.closed;
  }
}
