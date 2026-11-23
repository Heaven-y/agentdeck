import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { inspectDirectory } from '../platform/files/safe-file';
import type { WorkbenchPluginBackendRequest, WorkbenchPluginBackendResponse } from '@agentdeck/shared/plugins';
import { z } from 'zod';
import { WorkbenchPluginError } from './errors';

const Reply = z.discriminatedUnion('ok', [
  z.strictObject({ id: z.string(), ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ id: z.string(), ok: z.literal(false) }),
]);
const Response = z.strictObject({ status: z.number().int().min(100).max(599), body: z.unknown() });
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
const environmentKeys = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PSModulePath',
];

/** 本机后端运行于独立进程；不监听网络端口，不继承主应用的服务商凭据。 */
export class PluginBackend {
  private pending = new Map<string, Pending>();
  private stopped = false;
  private readonly exited: Promise<void>;
  private constructor(private readonly child: ChildProcess) {
    child.stderr?.resume();
    child.on('message', (message: unknown) => {
      if (JSON.stringify(message).length > 2 * 1024 * 1024) return this.fail();
      const reply = Reply.safeParse(message);
      if (!reply.success) return this.fail();
      const item = this.pending.get(reply.data.id);
      if (!item) return;
      this.pending.delete(reply.data.id);
      item.cleanup();
      if (reply.data.ok) item.resolve(reply.data.value);
      else item.reject(new WorkbenchPluginError('backend_failed'));
    });
    child.on('error', () => this.fail());
    this.exited = new Promise((resolve) => {
      const done = () => {
        this.rejectPending();
        resolve();
      };
      child.once('exit', done);
      child.once('close', done);
    });
  }
  static async start(entry: string, context: { dataDir: string; hostDataDir: string }): Promise<PluginBackend> {
    await inspectDirectory(context.dataDir, true);
    const env = Object.fromEntries(
      environmentKeys.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    );
    const runtime = new PluginBackend(
      fork(entry, [], {
        execArgv: [],
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      }),
    );
    try {
      await runtime.call('initialize', context, 10_000);
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }
  private rejectPending() {
    this.stopped = true;
    for (const item of this.pending.values()) {
      item.cleanup();
      item.reject(new WorkbenchPluginError('backend_failed'));
    }
    this.pending.clear();
  }
  private fail() {
    this.rejectPending();
    this.child.kill('SIGKILL');
  }
  private call(type: string, input: unknown, timeout: number, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.stopped || !this.child.connected) return Promise.reject(new WorkbenchPluginError('backend_failed'));
    if (this.pending.size >= 32) return Promise.reject(new WorkbenchPluginError('too_large'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', abort);
        if (this.child.connected) this.child.send({ id, type: 'cancel', input: null }, () => undefined);
        reject(new WorkbenchPluginError('backend_timeout'));
      }, timeout);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (this.child.connected) this.child.send({ id, type: 'cancel', input: null }, () => undefined);
        reject(new WorkbenchPluginError('plugin_disabled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        },
      });
      this.child.send({ id, type, input }, (error) => {
        if (error) this.fail();
      });
    });
  }
  async request(input: WorkbenchPluginBackendRequest, signal?: AbortSignal): Promise<WorkbenchPluginBackendResponse> {
    return Response.parse(await this.call('request', input, 40_000, signal));
  }
  get alive() {
    return !this.stopped;
  }
  async dispose(): Promise<void> {
    if (!this.stopped) {
      await this.call('dispose', null, 2_000).catch(() => undefined);
      this.rejectPending();
      if (this.child.connected) this.child.disconnect();
    }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
