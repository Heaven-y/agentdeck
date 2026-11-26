import { fileURLToPath } from 'node:url';
import { sameSessionDirectory } from '../../common/history/session-scope';
import { SessionError } from '../../errors';
import { managementObject as object, managementText as text, type ManagementRecord } from './management-rpc';
import type { SubagentTrajectoryIdentity } from '../history/session-management-types';
import { workflowSourceMatches } from '../history/workflow-agents';

export function assertReadIdentity(metadata: ManagementRecord, rootId: string, child?: SubagentTrajectoryIdentity) {
  if (child) {
    const matches = matchesChild(metadata, child);
    if (!matches) throw missing();
    return;
  }
  if (
    metadata.parentConversationId ||
    Number(metadata.nestingDepth ?? 0) !== 0 ||
    (metadata.rootConversationId && metadata.rootConversationId !== rootId)
  )
    throw missing();
}

export function missing() {
  return new SessionError(404, 'session_missing', 'Antigravity 在当前存储中没有此会话。');
}

function directories(metadata: ManagementRecord): string[] {
  if (Array.isArray(metadata.workspaceUris))
    return metadata.workspaceUris.filter((value): value is string => typeof value === 'string');
  return Array.isArray(metadata.workspaces)
    ? metadata.workspaces.map((value) => text(object(value).workspaceFolderAbsoluteUri)).filter(Boolean)
    : [];
}
export async function assertDirectory(metadata: ManagementRecord, dir: string) {
  const uris = [...new Set(directories(metadata))];
  if (uris.length !== 1) throw missing();
  let directory: string;
  try {
    directory = fileURLToPath(uris[0]!);
  } catch {
    throw missing();
  }
  if (!(await sameSessionDirectory(directory, dir))) throw missing();
}

function matchesChild(metadata: ManagementRecord, child: SubagentTrajectoryIdentity) {
  return child.workflow
    ? workflowSourceMatches(metadata, child)
    : metadata.parentConversationId === child.parentId &&
        metadata.rootConversationId === child.rootId &&
        metadata.nestingDepth === child.depth;
}
