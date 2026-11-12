import type { ElicitationRequest, ElicitationResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTurnInput } from '../contracts';
import { claudeQuestion, nativeElicitation } from '../common/user-interactions';
import { record } from '../common/user-interaction-fields';

export async function askClaudeQuestion(
  input: AgentTurnInput,
  toolInput: Record<string, unknown>,
  context: { runtimeId: string; signal: AbortSignal },
) {
  try {
    const prepared = claudeQuestion(toolInput);
    const answer = await input.requestInteraction?.(
      { spec: prepared.spec, runtimeId: context.runtimeId },
      { signal: context.signal },
    );
    if (answer?.action === 'submit')
      return { behavior: 'allow' as const, updatedInput: { ...toolInput, ...prepared.answer(answer) } };
  } catch {
    /* 不支持的原生问题保持拒绝，不用猜测答案继续。 */
  }
  return { behavior: 'deny' as const, message: '用户未提交问题答复。' };
}
export async function claudeElicitation(
  input: AgentTurnInput,
  request: ElicitationRequest,
  context: { runtimeId: string; requestId: string; signal: AbortSignal; sessionId?: string },
): Promise<ElicitationResult> {
  try {
    const prepared = nativeElicitation({ ...request, mode: request.mode ?? 'form' });
    const answer = await input.requestInteraction?.(
      {
        spec: { ...prepared.spec, source: request.serverName },
        runtimeId: context.runtimeId,
        completionId: request.elicitationId ? JSON.stringify([request.serverName, request.elicitationId]) : undefined,
        scope: { kind: context.sessionId ? 'session' : 'nativeOperation', id: context.sessionId ?? context.requestId },
      },
      { signal: context.signal },
    );
    return prepared.answer(answer ?? { action: 'cancel' }) as ElicitationResult;
  } catch {
    return { action: 'cancel' };
  }
}
export function claudeElicitationCompleted(
  input: AgentTurnInput,
  message: unknown,
  runtime: { id: string; sessionId?: string },
): boolean {
  const value = record(message);
  if (value.type !== 'system' || value.subtype !== 'elicitation_complete') return false;
  if (
    value.session_id === runtime.sessionId &&
    typeof value.mcp_server_name === 'string' &&
    typeof value.elicitation_id === 'string'
  )
    input.completeInteraction?.(runtime.id, JSON.stringify([value.mcp_server_name, value.elicitation_id]));
  return true;
}
