import { randomUUID } from 'node:crypto';
import type { AgentTurnInput } from '../contracts';
import { codexQuestion, nativeElicitation } from '../common/user-interactions';
import type { CodexClient } from './client';
import type { RpcId, ServerRequest } from './types';
import { isMcpToolApproval } from './mcp-approval';

type Pending = { controller: AbortController; turnId?: string };
/** 连接级交互保留无turnId的MCP请求，原生撤销与实例关闭负责清理。 */
export class CodexInteractions {
  readonly runtimeId = randomUUID();
  private pending = new Map<RpcId, Pending>();
  constructor(
    private readonly client: CodexClient,
    private readonly current: () => { input: AgentTurnInput; sessionId: string; matchesTurn(id: string): boolean },
  ) {}
  request(request: ServerRequest): boolean {
    if (!['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(request.method)) return false;
    if (isMcpToolApproval(request) && request.params.turnId != null) return false;
    if (this.pending.has(request.id)) return true;
    const context = this.current();
    const turnId = typeof request.params.turnId === 'string' ? request.params.turnId : undefined;
    if (!this.belongs(request, context) || this.pending.size >= 32) {
      this.client.rejectRequest(request.id);
      return true;
    }
    const controller = new AbortController();
    this.pending.set(request.id, { controller, turnId: request.params.isBlocking === false ? undefined : turnId });
    void this.answer(request, context, controller);
    return true;
  }
  private belongs(request: ServerRequest, context: ReturnType<CodexInteractions['current']>): boolean {
    if (request.params.threadId !== context.sessionId) return false;
    if (typeof request.params.turnId === 'string' && !context.matchesTurn(request.params.turnId)) return false;
    return request.method !== 'item/tool/requestUserInput' || validItem(request.params.itemId);
  }
  private async answer(
    request: ServerRequest,
    context: ReturnType<CodexInteractions['current']>,
    controller: AbortController,
  ) {
    try {
      const prepared =
        request.method === 'item/tool/requestUserInput'
          ? codexQuestion(request.params)
          : nativeElicitation(request.params);
      const answer = await context.input.requestInteraction?.(
        {
          spec: prepared.spec,
          runtimeId: this.runtimeId,
          ...(request.params.turnId == null || request.params.isBlocking === false
            ? { scope: { kind: 'session' as const, id: context.sessionId } }
            : {}),
        },
        { signal: controller.signal },
      );
      if (!this.pending.has(request.id) || controller.signal.aborted) return;
      this.pending.delete(request.id);
      this.client.respond(request.id, prepared.answer(answer ?? { action: 'cancel' }));
    } catch {
      if (this.pending.delete(request.id)) this.client.rejectRequest(request.id);
    }
  }
  resolved(id: unknown): void {
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const p = this.pending.get(id);
    this.pending.delete(id);
    p?.controller.abort();
  }
  cancelTurn(id: string): void {
    for (const [key, p] of this.pending) if (p.turnId === id) this.cancel(key);
  }
  private cancel(id: RpcId) {
    const p = this.pending.get(id);
    this.pending.delete(id);
    p?.controller.abort();
    this.client.rejectRequest(id);
  }
  close(): void {
    for (const key of this.pending.keys()) this.cancel(key);
  }
}
function validItem(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}
