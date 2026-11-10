import { randomUUID } from 'node:crypto';
import type { AgentTurnInput } from '../../contracts';
import { nativeElicitation } from '../../common/user-interactions';
import { type AcpConnection, type AcpRequest, type AcpId, type AcpRecord } from './types';
export class AcpInteractions {
  readonly runtimeId = randomUUID();
  private pending = new Map<AcpId, AbortController>();
  private readonly lifetime = new AbortController();
  constructor(
    private readonly client: AcpConnection,
    private readonly input: AgentTurnInput,
    private readonly session: () => string | undefined,
  ) {}
  request(request: AcpRequest): boolean {
    if (request.method !== 'elicitation/create') return false;
    if (this.pending.has(request.id)) return true;
    if (!this.owns(request) || this.pending.size >= 32) {
      this.client.reject(request.id);
      return true;
    }
    const controller = new AbortController();
    this.pending.set(request.id, controller);
    void this.answer(request, controller);
    return true;
  }
  private owns(request: AcpRequest): boolean {
    const { sessionId, requestId } = request.params;
    if (requestId !== undefined && !this.knownRequest(requestId)) return false;
    if (sessionId !== undefined) return sessionId === this.session();
    return this.knownRequest(requestId);
  }
  private knownRequest(id: unknown): boolean {
    return (typeof id === 'string' || typeof id === 'number') && this.client.ownsRequest?.(id) === true;
  }
  private async answer(request: AcpRequest, controller: AbortController) {
    try {
      const prepared = nativeElicitation(request.params);
      const answer = await this.input.requestInteraction?.(
        {
          spec: prepared.spec,
          runtimeId: this.runtimeId,
          completionId: typeof request.params.elicitationId === 'string' ? request.params.elicitationId : undefined,
          ...(typeof request.params.requestId === 'string' || typeof request.params.requestId === 'number'
            ? { scope: { kind: 'nativeOperation' as const, id: String(request.params.requestId) } }
            : {}),
        },
        { signal: AbortSignal.any([controller.signal, this.lifetime.signal]) },
      );
      if (!this.pending.delete(request.id) || controller.signal.aborted) return;
      this.client.respond(request.id, prepared.answer(answer ?? { action: 'cancel' }));
    } catch {
      if (this.pending.delete(request.id)) this.client.respond(request.id, { action: 'cancel' });
    }
  }
  close(): void {
    this.lifetime.abort();
    for (const [id, controller] of this.pending) {
      this.pending.delete(id);
      controller.abort();
      this.client.respond(id, { action: 'cancel' });
    }
  }
  complete(params: AcpRecord): void {
    if (params.sessionId !== undefined && params.sessionId !== this.session()) return;
    if (typeof params.elicitationId === 'string')
      this.input.completeInteraction?.(this.runtimeId, params.elicitationId);
  }
}
