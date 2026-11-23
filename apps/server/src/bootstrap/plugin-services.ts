import type { WorkbenchPluginHostRequest } from '@agentdeck/shared/plugins';
import type { WorkspaceStore } from '../workspaces/store';
import type { SessionsService } from '../sessions/service';
import { SessionError } from '../agents/errors';

/** 启动时注入原生会话已有的分页与归属校验，插件不另建历史存储。 */
export function createPluginHostServices(
  store: Pick<WorkspaceStore, 'list' | 'get'>,
  sessions: Pick<SessionsService, 'page' | 'readHistoryPage'>,
) {
  return async (request: WorkbenchPluginHostRequest, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    if (request.method === 'projects.list') return store.list();
    const params = request.params;
    const workspace = await store.get(params.projectId);
    if (!workspace) throw new SessionError(404, 'workspace_missing', '项目不存在');
    if (request.method === 'sessions.list') return sessions.page({ ...request.params, scope: 'active' }, signal);
    return sessions.readHistoryPage(workspace, request.params, request.params.before, signal);
  };
}
