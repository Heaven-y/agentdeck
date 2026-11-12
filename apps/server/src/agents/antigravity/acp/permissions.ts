import { randomUUID } from 'node:crypto';
import type { AgentTurnInput } from '../../contracts';
import { object, text, list, type AcpConnection, type AcpRequest, type AcpId } from './types';

type Pending = { request: AcpRequest; appId: string; timer: NodeJS.Timeout };
export class AcpPermissions {
  private readonly pending = new Map<AcpId, Pending>();
  private stopped = false;
  constructor(
    private readonly client: AcpConnection,
    private readonly input: AgentTurnInput,
    private readonly sessionId: string,
  ) {}

  request(request: AcpRequest): void {
    if (this.pending.has(request.id)) return;
    if (request.method !== 'session/request_permission' || request.params.sessionId !== this.sessionId) {
      this.client.reject(request.id);
      return;
    }
    if (this.stopped || this.pending.size >= 32) {
      this.client.respond(request.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const tool = object(request.params.toolCall);
    const appId = randomUUID();
    const timer = setTimeout(() => this.finish(request.id, 'cancelled'), 300_000);
    this.pending.set(request.id, { request, appId, timer });
    const toolName = text(tool.name) || text(tool.title) || '原生工具';
    const input = object(tool.rawInput ?? tool.args);
    this.input.emit({ type: 'permission_request', requestId: appId, toolName, input });
    void this.input.requestPermission({ requestId: appId, toolName, input }).then(
      (answer) => this.finish(request.id, answer.allow ? 'allowed' : 'denied'),
      () => this.finish(request.id, 'cancelled'),
    );
  }

  private finish(id: AcpId, decision: 'allowed' | 'denied' | 'cancelled'): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const kind = decision === 'allowed' ? 'allow_once' : 'reject_once';
    const selected = list(pending.request.params.options)
      .map(object)
      .filter((option) => option.kind === kind);
    const optionId = selected.length === 1 ? text(selected[0]!.optionId) : '';
    const outcome = decision !== 'cancelled' && optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    this.client.respond(id, { outcome });
    this.input.emit({
      type: 'permission_resolved',
      requestId: pending.appId,
      decision: outcome.outcome === 'cancelled' ? 'cancelled' : decision,
    });
  }
  cancel(): void {
    this.stopped = true;
    for (const id of this.pending.keys()) this.finish(id, 'cancelled');
  }
}
