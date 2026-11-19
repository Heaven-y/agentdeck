import type { OfficialUsage } from '@agentdeck/shared/conversation';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NativeSessionIdSchema } from '@agentdeck/shared/conversation';
import { assertCapabilityDirectory } from '../../agents/common/capability-directory';
import { SessionError } from '../../agents/errors';
import type { SessionsService } from '../../sessions/service';
import type { WorkspaceStore } from '../../workspaces/store';
import { requestSignal } from '../request-signal';

const Params = z.strictObject({ id: z.string().min(1).max(200) });
const Query = z.strictObject({ sessionId: NativeSessionIdSchema.optional() });
export function registerCodexUsageRoute(
  app: FastifyInstance,
  deps: { store: Pick<WorkspaceStore, 'get'>; sessions: Pick<SessionsService, 'assertBelongs'> },
  read: (dir: string, signal: AbortSignal) => Promise<OfficialUsage>,
) {
  app.post('/api/workspaces/:id/codex/official-usage', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = Params.safeParse(req.params);
    const query = Query.safeParse(req.query);
    if (!parsed.success || !query.success) return reply.code(400).send({ message: '额度查询请求格式不正确。' });
    const signal = requestSignal(req, reply);
    try {
      const workspace = await deps.store.get(parsed.data.id);
      if (signal.aborted) return reply;
      if (!workspace) return reply.code(404).send({ message: '项目不存在。' });
      if (query.data.sessionId) await assertCapabilityDirectory(workspace.dir);
      const scope = query.data.sessionId
        ? await deps.sessions.assertBelongs(workspace, 'codex', query.data.sessionId, signal)
        : workspace;
      await assertCapabilityDirectory(scope.dir);
      signal.throwIfAborted();
      return await read(scope.dir, signal);
    } catch (error) {
      if (signal.aborted) return reply;
      const failure =
        error instanceof SessionError
          ? error
          : new SessionError(503, 'codex_official_usage_unavailable', '暂时无法读取 Codex 官方额度。');
      return reply.code(failure.status).send({ code: failure.code, message: failure.message });
    }
  });
}
