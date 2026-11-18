import { randomUUID } from 'node:crypto';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativeMcpOperation } from '@agentdeck/shared/settings';
import { NativeManagementError } from '../errors';
type Owner = { agent: AgentKind; projectId?: string; instanceId: string; name: string };
export type McpOAuthSession = {
  signal: AbortSignal;
  authorize(url: string): void;
};
type Operation = {
  owner: Owner;
  public: NativeMcpOperation;
  abort: AbortController;
  expires: number;
};
const active = (op: Operation) => ['running', 'waiting'].includes(op.public.state);
/** 回调与令牌由原生 app-server 接收；HTTP 轮询只返回状态与原生授权链接。 */
export class McpOAuthOperations {
  private readonly operations = new Map<string, Operation>();
  start(owner: Owner, run: (session: McpOAuthSession) => Promise<void>, lifetime?: AbortSignal): NativeMcpOperation {
    for (const [id, op] of this.operations) if (!active(op) && op.expires < Date.now()) this.operations.delete(id);
    const existing = [...this.operations.values()].find(
      (op) => active(op) && JSON.stringify(op.owner) === JSON.stringify(owner),
    );
    if (existing) return { ...existing.public };
    if (this.operations.size >= 32 || lifetime?.aborted) throw new NativeManagementError('native_unavailable');
    const id = randomUUID(),
      abort = new AbortController();
    const op: Operation = {
      owner,
      abort,
      expires: Date.now() + 600_000,
      public: { id, instanceId: owner.instanceId, name: owner.name, state: 'running' },
    };
    this.operations.set(id, op);
    const close = () => this.finish(op, 'cancelled');
    lifetime?.addEventListener('abort', close, { once: true });
    const timer = setTimeout(() => this.finish(op, 'expired'), 120_000);
    timer.unref();
    void run({
      signal: abort.signal,
      authorize: (url) => {
        if (!active(op)) return;
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 16384)
          throw new Error();
        op.public = { ...op.public, state: 'waiting', authorizationUrl: url };
      },
    })
      .then(
        () => this.finish(op, 'completed'),
        () => this.finish(op, 'failed'),
      )
      .finally(() => {
        clearTimeout(timer);
        lifetime?.removeEventListener('abort', close);
      });
    return { ...op.public };
  }
  private finish(op: Operation, state: NativeMcpOperation['state']) {
    if (!active(op)) return;
    op.public = { id: op.public.id, instanceId: op.public.instanceId, name: op.public.name, state };
    op.abort.abort();
  }
  private owned(agent: AgentKind, projectId: string | undefined, id: string) {
    const op = this.operations.get(id);
    if (!op || op.owner.agent !== agent || op.owner.projectId !== projectId)
      throw new NativeManagementError('native_unavailable');
    return op;
  }
  get(agent: AgentKind, projectId: string | undefined, id: string) {
    return { ...this.owned(agent, projectId, id).public };
  }
  list(agent: AgentKind, projectId: string | undefined) {
    return [...this.operations.values()]
      .filter((op) => op.owner.agent === agent && op.owner.projectId === projectId && active(op))
      .map((op) => ({ ...op.public }));
  }
  cancel(agent: AgentKind, projectId: string | undefined, id: string) {
    const op = this.owned(agent, projectId, id);
    this.finish(op, 'cancelled');
    return { ...op.public };
  }
  dispose() {
    for (const op of this.operations.values()) this.finish(op, 'cancelled');
  }
}
