import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveLocalCommand, type ResolvedCommand } from '../../../platform/process/executable';
import { AntigravityLines } from '../run/lines';
import { antigravityBackgroundEnvironment } from '../run/process-environment';
import { readInitialAgentUpdate } from './history-stream';
import {
  managementFailure,
  managementObject,
  managementRequest,
  type ManagementBackend,
  type ManagementRecord,
} from './management-rpc';

type Method = 'initialize' | 'session/list';
type Pending = {
  method: Method;
  resolve(value?: ManagementRecord): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
};
export type ManagementProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  geminiDir: string;
  signal?: AbortSignal;
  /** 只有读账号需等列表成功；本机历史不依赖登录。 */
  waitForSessionList?: boolean;
  /** 可传入已从原始环境解析的命令，避免隔离配置影响可执行文件定位。 */
  command?: ResolvedCommand;
};

class ManagementProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly closed: Promise<void>;
  private exited = false;
  private failed = false;
  private sequence = 0;
  private bytes = 0;
  private closeTask?: Promise<void>;
  constructor(
    command: ResolvedCommand,
    options: ManagementProcessOptions,
    log: string,
    private readonly onFailure: () => void,
  ) {
    this.child = spawn(
      command.command,
      [
        ...command.args,
        'acp',
        '--gemini-dir',
        options.geminiDir,
        '--app-data-dir',
        'antigravity-cli',
        '--disable-telemetry',
        '--log-file',
        log,
      ],
      {
        cwd: options.cwd,
        env: antigravityBackgroundEnvironment(options.env),
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const lines = new AntigravityLines((line) => this.receive(line), 2 * 1024 * 1024);
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.count(chunk.length);
        lines.push(chunk);
      } catch {
        this.fail();
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      try {
        this.count(chunk.length);
      } catch {
        this.fail();
      }
    });
    this.child.stdin.on('error', () => this.fail());
    this.child.once('error', () => this.fail());
    this.closed = new Promise((resolve) =>
      this.child.once('close', () => {
        this.exited = true;
        this.fail();
        resolve();
      }),
    );
  }
  get pid() {
    return this.child.pid;
  }
  get alive() {
    return !this.exited && !this.failed;
  }
  private count(bytes: number) {
    this.bytes += bytes;
    if (this.bytes > 4 * 1024 * 1024) throw managementFailure();
  }
  private fail() {
    this.failed = true;
    this.onFailure();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(managementFailure());
    }
    this.pending.clear();
  }
  private receive(line: string) {
    const value = managementObject(JSON.parse(line));
    if (typeof value.id !== 'number') return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (!value.error) pending.resolve(managementObject(value.result));
    else if (pending.method === 'session/list' && managementObject(value.error).code === -32000) pending.resolve();
    else {
      this.fail();
      pending.reject(managementFailure());
    }
  }
  request(method: Method, params: ManagementRecord, timeoutMs?: number): Promise<ManagementRecord | undefined> {
    if (!this.alive) return Promise.reject(managementFailure());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(managementFailure());
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { method, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  private async waitClosed(ms: number) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }
  close(): Promise<void> {
    this.fail();
    this.closeTask ??= this.stop();
    return this.closeTask;
  }
  private async stop() {
    if (this.exited) return;
    this.child.stdin.end();
    await this.waitClosed(2000);
    if (this.exited) return;
    if (process.platform === 'win32' && this.child.pid) await this.killTree();
    else this.child.kill('SIGKILL');
    await this.waitClosed(2000);
    if (!this.exited) throw managementFailure();
  }
  private killTree(): Promise<void> {
    return new Promise((resolve) => {
      const killer = spawn(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(this.child.pid), '/T', '/F'],
        { windowsHide: true, shell: false, stdio: 'ignore' },
      );
      const timer = setTimeout(() => {
        killer.kill();
        this.child.kill('SIGKILL');
        resolve();
      }, 2000);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      killer.once('close', finish);
      killer.once('error', () => {
        this.child.kill('SIGKILL');
        finish();
      });
    });
  }
}

function portFromLog(log: string, owner: number | undefined): number | undefined {
  const pid = Number(/Starting language server process with pid (\d+)/.exec(log)?.[1]);
  const port = Number(/Language server listening on random port at (\d+) for HTTP\r?\n/.exec(log)?.[1]);
  return pid === owner && port > 0 && port <= 65535 ? port : undefined;
}
function fileMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/** 日志路径是本次 mkdtemp 创建的；必须同时匹配自己的后端 PID 和 HTTP 端口。 */
async function ownPort(file: string, process: ManagementProcess): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && process.alive) {
    try {
      if ((await stat(file)).size > 512 * 1024) throw managementFailure();
      const log = await readFile(file, 'utf8');
      const port = portFromLog(log, process.pid);
      if (port && process.alive) return port;
    } catch (error) {
      if (!fileMissing(error)) throw managementFailure();
    }
    await delay(30);
  }
  throw managementFailure();
}

async function managementPort(process: ManagementProcess, options: ManagementProcessOptions, log: string) {
  const init = await process.request(
    'initialize',
    { protocolVersion: 1, clientInfo: { name: 'agentdeck-session-manager', version: '1' }, clientCapabilities: {} },
    15_000,
  );
  if (managementObject(init?.agentInfo).name !== 'Antigravity ACP Server') throw managementFailure();
  // 同一个列表请求负责引导。端口早于账号就绪，只有账号读取等待成功答复。
  const list = process.request('session/list', { cwd: options.cwd }, options.waitForSessionList ? 15_000 : undefined);
  if (options.waitForSessionList) {
    if (!Array.isArray((await list)?.sessions)) throw managementFailure();
  } else void list.catch(() => undefined);
  return ownPort(log, process);
}

export async function startManagementBackend(options: ManagementProcessOptions): Promise<ManagementBackend> {
  if (options.signal?.aborted) throw managementFailure();
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-agy-management-'));
  const log = path.join(temporary, 'runtime.log');
  let process: ManagementProcess | undefined;
  const requests = new AbortController();
  const abort = () => {
    requests.abort();
    void process?.close().catch(() => undefined);
  };
  const close = async () => {
    requests.abort();
    options.signal?.removeEventListener('abort', abort);
    await process?.close();
    await rm(temporary, { recursive: true, force: true });
  };
  try {
    if (options.signal?.aborted) throw managementFailure();
    process = new ManagementProcess(options.command ?? resolveLocalCommand('agy', options.env), options, log, () =>
      requests.abort(),
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    const port = await managementPort(process, options, log);
    return {
      request: (method, params, budget) =>
        process?.alive
          ? managementRequest(port, method, params, { signal: requests.signal, budget })
          : Promise.reject(managementFailure()),
      readInitialUpdate: (params, limit) =>
        process?.alive
          ? readInitialAgentUpdate(port, params, { signal: requests.signal, limit })
          : Promise.reject(managementFailure()),
      close,
    };
  } catch {
    await close();
    throw managementFailure();
  }
}
