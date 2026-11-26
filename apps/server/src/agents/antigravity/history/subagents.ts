import { fileURLToPath } from 'node:url';
import type { NativeMediaLocator, SubagentQuery, SubagentRead, SubagentSummary } from '@agentdeck/shared/conversation';
import { sameSessionDirectory } from '../../common/history/session-scope';
import { imageSource, mediaMissing } from '../../common/media/native-media';
import {
  subagentEvents,
  subagentGraph,
  type SubagentNode,
  type SubagentGraphInput,
} from '../../common/history/subagents';
import { list, record, text } from '../../common/interaction/user-interaction-fields';
import { antigravityHistory } from './history';
import type { SubagentTrajectoryIdentity } from './session-management-types';
import { workflowAgentEdges, workflowSourceMatches, type WorkflowAgentEdge } from './workflow-agents';
import { recordedGenerationUsage } from '../run/metrics';

type Snapshot = { trajectory: Record<string, unknown>; status?: string; edge?: WorkflowAgentEdge };
type ReadTrajectory = (
  id: string,
  dir: string,
  child?: SubagentTrajectoryIdentity,
  signal?: AbortSignal,
) => Promise<Snapshot>;
const meta = (value: Snapshot) => record(value.trajectory.metadata);
async function matchesWorkspace(value: unknown, dir: string) {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') return false;
  try {
    return await sameSessionDirectory(fileURLToPath(value[0]), dir);
  } catch {
    return false;
  }
}
function edges(value: Snapshot) {
  return [
    ...workflowAgentEdges(value.trajectory),
    ...list(value.trajectory.steps)
      .map(record)
      .filter((step) => step.type === 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT')
      .flatMap((step) => {
        const invoke = record(step.invokeSubagent);
        return list(invoke.results).map((value, index) => {
          const result = record(value),
            spec = record(list(invoke.subagents)[index]);
          return {
            agentId: text(result.conversationId),
            ...(text(spec.typeName) ? { name: text(spec.typeName) } : {}),
            ...(text(spec.role) ? { role: text(spec.role) } : {}),
          };
        });
      }),
  ];
}
async function validate(
  value: Snapshot,
  context: { id: string; root: string; dir: string; parent?: SubagentNode<Snapshot> },
) {
  const { id, root, dir, parent } = context;
  const metadata = meta(value);
  if (value.trajectory.cascadeId !== id || !(await matchesWorkspace(metadata.workspaceUris, dir))) return false;
  if (!parent) return validRoot(metadata, root);
  const edge = workflowAgentEdges(parent.value.trajectory).findLast((entry) => entry.agentId === id);
  if (edge?.kind === 'run_workflow')
    return workflowSourceMatches(metadata, {
      id,
      parentId: parent.id,
      rootId: root,
      depth: parent.depth + 1,
      workflow: edge,
    });
  if (!matchesParent(metadata, parent, root)) return false;
  if (edge && edge.kind === 'swarm') return true;
  return matchesInvokeResult(parent.value.trajectory, id, dir);
}
async function matchesInvokeResult(trajectory: Record<string, unknown>, id: string, dir: string) {
  const nativeResult = list(trajectory.steps)
    .map(record)
    .flatMap((step) => list(record(step.invokeSubagent).results).map(record))
    .find((result) => result.conversationId === id);
  return !!nativeResult && (await matchesWorkspace(nativeResult.workspaceUris, dir));
}
function validRoot(metadata: Record<string, unknown>, root: string) {
  return (
    !metadata.parentConversationId &&
    Number(metadata.nestingDepth ?? 0) === 0 &&
    (!metadata.rootConversationId || metadata.rootConversationId === root)
  );
}
function idleStatus(value: Snapshot): SubagentSummary['status'] {
  if (value.status !== 'CASCADE_RUN_STATUS_IDLE' || value.edge?.kind === 'swarm') return 'unknown';
  if (value.edge?.kind !== 'run_workflow') return 'completed';
  return list(value.trajectory.steps).some(
    (step) => record(step).type === 'CORTEX_STEP_TYPE_FINISH' && record(step).status === 'CORTEX_STEP_STATUS_DONE',
  )
    ? 'completed'
    : 'unknown';
}
function trajectoryStatus(value: Snapshot): SubagentSummary['status'] {
  if (value.edge?.cancelled) return 'cancelled';
  if (value.status === 'CASCADE_RUN_STATUS_RUNNING') return 'running';
  const statuses = list(value.trajectory.steps).map((step) => record(step).status);
  if (statuses.some((status) => ['CORTEX_STEP_STATUS_ERROR', 'CORTEX_STEP_STATUS_INVALID'].includes(text(status))))
    return 'failed';
  if (
    statuses.some((status) => ['CORTEX_STEP_STATUS_CANCELED', 'CORTEX_STEP_STATUS_INTERRUPTED'].includes(text(status)))
  )
    return 'cancelled';
  return idleStatus(value);
}
function graph(read: ReadTrajectory, input: SubagentGraphInput & { dir: string }) {
  const { id, dir, signal } = input;
  return subagentGraph(
    {
      load: async (child, parent) => {
        const edge = parent && workflowAgentEdges(parent.value.trajectory).findLast((entry) => entry.agentId === child);
        const value = await read(
          id,
          dir,
          parent
            ? {
                id: child,
                parentId: parent.id,
                rootId: id,
                depth: parent.depth + 1,
                ...(edge?.kind === 'run_workflow'
                  ? { workflow: { stepIndex: edge.stepIndex, toolCallId: edge.toolCallId } }
                  : {}),
              }
            : undefined,
          signal,
        );
        return { ...value, edge };
      },
      validate: (value, child, parent) => validate(value, { id: child, root: id, dir, parent }),
      children: edges,
      status: trajectoryStatus,
      describe: (value) => ({ usage: recordedGenerationUsage(value.trajectory) }),
    },
    input,
  );
}
export function createAntigravitySubagents(read: ReadTrajectory) {
  return async (id: string, dir: string, query: SubagentQuery, signal?: AbortSignal): Promise<SubagentRead> => {
    const result = await graph(read, { id, dir, query, signal });
    if (!result.selected)
      return {
        agentIds: result.children.map((child) => child.id),
        summaries: result.children.map((child) => child.summary!),
      };
    const child = result.selected;
    const all = subagentEvents(antigravityHistory(child.value.trajectory), id, child.id);
    // 按完整事件边界分页，不拆开工具结果与其统计；原生轨迹读取本身另有限额。
    const offset = Number(query.cursor ?? 0);
    let end = Math.min(offset + 100, all.length);
    while (end < all.length && all[end - 1]?.type !== 'turn_end') end++;
    const events = all.slice(offset, end);
    return {
      agentId: child.id,
      summary: child.summary,
      ...(child.summary?.parentAgentId ? { parentAgentId: child.summary.parentAgentId } : {}),
      events,
      ...(end < all.length ? { nextCursor: String(end) } : {}),
    };
  };
}
export function createAntigravitySubagentMedia(read: ReadTrajectory) {
  return async (id: string, dir: string, locator: NativeMediaLocator, signal?: AbortSignal) => {
    if (!locator.subagentId || locator.kind !== 'user') throw mediaMissing();
    const child = (await graph(read, { id, dir, query: {}, signal, findId: locator.subagentId })).selected;
    const step = record(list(child?.value.trajectory.steps)[Number(locator.messageId)]);
    if (step.type !== 'CORTEX_STEP_TYPE_USER_INPUT') throw mediaMissing();
    return imageSource(list(record(step.userInput).media)[locator.index]);
  };
}

function matchesParent(metadata: Record<string, unknown>, parent: SubagentNode<Snapshot>, root: string) {
  return (
    metadata.parentConversationId === parent.id &&
    metadata.rootConversationId === root &&
    metadata.nestingDepth === parent.depth + 1
  );
}
