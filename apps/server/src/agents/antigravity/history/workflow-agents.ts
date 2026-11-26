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
function agentBlocks(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 8) return [];
  return list(value)
    .slice(0, 256)
    .flatMap((item) => {
      const block = record(item),
        agent = record(block.agent);
      return text(agent.conversationId)
        ? [agent]
        : agentBlocks(record(record(block.step).renderInfo).contentBlocks, depth + 1);
    });
}

/** 只接受原生工具提供的代理块，不从正文或任意 JSON 字符串猜会话身份。 */
export function workflowAgentEdges(trajectory: Record<string, unknown>): WorkflowAgentEdge[] {
  return list(trajectory.steps).flatMap((value, stepIndex) => {
    const step = record(value),
      call = record(record(step.metadata).toolCall);
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
