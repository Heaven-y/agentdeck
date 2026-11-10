import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTurnInput } from '../contracts';
import { record } from '../common/user-interaction-fields';
import { claudeElicitation, claudeElicitationCompleted } from './interactions';
type Recipient = { input: AgentTurnInput; sessionId?: string; expires: number };
/** 会话空闲时使用最近的拥有者；完成通知始终返回创建原操作的页面。 */
export class ClaudeElicitationOwner {
  private readonly recipients = new Map<string, Recipient>();
  constructor(
    private readonly runtimeId: string,
    private readonly current: () => { input: AgentTurnInput; sessionId?: string },
  ) {}
  async request(
    request: ElicitationRequest,
    context: { requestId: string; signal: AbortSignal },
  ): Promise<ElicitationResult> {
    this.prune();
    const target = this.current();
    const key =
      request.mode === 'url' && request.elicitationId
        ? JSON.stringify([request.serverName, request.elicitationId])
        : undefined;
    if (key && (this.recipients.has(key) || this.recipients.size >= 32)) return { action: 'cancel' };
    if (key) this.recipients.set(key, { ...target, expires: Date.now() + 300_000 });
    const result = await claudeElicitation(target.input, request, {
      ...context,
      runtimeId: this.runtimeId,
      sessionId: target.sessionId,
    });
    if (key && result.action !== 'accept') this.recipients.delete(key);
    return result;
  }
  complete(message: unknown): boolean {
    this.prune();
    const value = record(message);
    if (value.type !== 'system' || value.subtype !== 'elicitation_complete') return false;
    const key = completionKey(value);
    if (!key) return true;
    const target = this.recipients.get(key);
    if (!target) return true;
    const sessionId = target.sessionId ?? this.current().sessionId;
    if (value.session_id !== sessionId) return true;
    this.recipients.delete(key);
    return claudeElicitationCompleted(target.input, message, { id: this.runtimeId, sessionId });
  }
  close(): void {
    this.recipients.clear();
  }
  private prune(): void {
    for (const [key, value] of this.recipients) if (value.expires <= Date.now()) this.recipients.delete(key);
  }
}
function completionKey(value: Record<string, unknown>): string | undefined {
  if (typeof value.mcp_server_name !== 'string' || typeof value.elicitation_id !== 'string') return;
  return JSON.stringify([value.mcp_server_name, value.elicitation_id]);
}
