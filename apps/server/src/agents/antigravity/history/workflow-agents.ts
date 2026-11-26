import { list, record, text } from '../../common/interaction/user-interaction-fields';
import type { SubagentTrajectoryIdentity } from './session-management-types';

export type WorkflowAgentEdge = {
  agentId: string;
  name?: string;
  role?: string;
  kind: 'swarm' | 'run_workflow';
  stepIndex: number;
  toolCallId: string;
  cancelled: boolean;
};
function agentBlocks(value: unknown): Record<string, unknown>[] {
  const blocks = [...list(value)],
    result: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  while (blocks.length) {
    const value = blocks.pop();
    if (seen.has(value)) continue;
    seen.add(value);
    const block = record(value),
      agent = record(block.agent);
    if (text(agent.conversationId)) result.push(agent);
    else blocks.push(...list(record(record(block.step).renderInfo).contentBlocks));
  }
  return result.reverse();
}

/** 只接受原生工具提供的代理块，不从正文或任意 JSON 字符串猜会话身份。 */
export function workflowAgentEdges(trajectory: Record<string, unknown>): WorkflowAgentEdge[] {
  return list(trajectory.steps).flatMap((value, offset) => {
    const step = record(value),
      call = record(record(step.metadata).toolCall);
    const stepIndex = typeof step.index === 'number' ? step.index : offset;
    if (
      step.type !== 'CORTEX_STEP_TYPE_GENERIC' ||
      !['swarm', 'run_workflow'].includes(text(call.name)) ||
      !text(call.id)
    )
      return [];
    const info = record(record(record(step.generic).result).stepRenderInfo);
    return agentBlocks(info.contentBlocks).map((agent) => ({
      agentId: text(agent.conversationId),
      name: text(agent.title),
      role: text(agent.subtitle),
      kind: call.name as WorkflowAgentEdge['kind'],
      stepIndex,
      toolCallId: text(call.id),
      cancelled: step.status === 'CORTEX_STEP_STATUS_DONE' && info.titlePrefix === 'Killed',
    }));
  });
}

export function workflowSourceMatches(
  metadata: Record<string, unknown>,
  identity: SubagentTrajectoryIdentity,
): boolean {
  const expected = identity.workflow;
  if (!expected) return false;
  const source = record(metadata.sourceMetadata),
    tool = record(source.tool),
    call = record(tool.toolCall);
  return (
    source.hideFromConversationList === true &&
    metadata.rootConversationId === identity.rootId &&
    tool.conversationId === identity.parentId &&
    (tool.stepIndex ?? 0) === expected.stepIndex &&
    call.name === 'run_workflow' &&
    call.id === expected.toolCallId
  );
}
