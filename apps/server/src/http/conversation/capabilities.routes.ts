import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentKindSchema, NativeSessionIdSchema } from '@agentdeck/shared/conversation';
import type { CapabilitiesService } from '../../chat/capabilities/capabilities';
import { SessionError } from '../../agents/errors';
import { type SessionsService } from '../../sessions/service';
import type { WorkspaceStore } from '../../workspaces/store';
import { assertCapabilityDirectory } from '../../agents/common/capability-directory';
import type { SessionRef, AntigravityMainAgents } from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';

const Params = z.object({ id: z.string().min(1) });
const Query = z.object({ agent: AgentKindSchema, sessionId: NativeSessionIdSchema.optional() }).strict();
export function registerCapabilityRoutes(
  app: FastifyInstance,
  deps: {
    store: Pick<WorkspaceStore, 'get'>;
    capabilities: CapabilitiesService;
    sessions: Pick<SessionsService, 'assertBelongs'>;
    runtimeWorkspace?(workspace: Workspace, session: SessionRef): Promise<Workspace | undefined>;
    mainAgents?(dir: string, sessionId?: string, signal?: AbortSignal): Promise<AntigravityMainAgents>;
  },
): void {
  if (deps.mainAgents)
    app.get('/api/workspaces/:id/antigravity-agents', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const params = Params.safeParse(req.params);
      const query = z.object({ sessionId: NativeSessionIdSchema.optional() }).safeParse(req.query);
      if (!params.success || !query.success) return reply.code(400).send({ message: '主代理请求格式不正确。' });
      const workspace = await deps.store.get(params.data.id);
      if (!workspace) return reply.code(404).send({ message: '工作区不存在。' });
      const controller = new AbortController();
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) controller.abort();
      });
      try {
        const scope = query.data.sessionId
          ? await deps.sessions.assertBelongs(workspace, 'antigravity', query.data.sessionId, controller.signal)
          : workspace;
        return await deps.mainAgents!(scope.dir, query.data.sessionId, controller.signal);
      } catch (error) {
        return reply
          .code(error instanceof SessionError ? error.status : 503)
          .send({ message: error instanceof SessionError ? error.message : '主代理列表读取失败，请重试。' });
      }
    });
  app.route({
    method: ['GET', 'POST'],
    url: '/api/workspaces/:id/agent-capabilities',
    handler: async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const params = Params.safeParse(req.params);
      const query = Query.safeParse(req.query);
      if (!params.success || !query.success) return reply.code(400).send({ message: '能力请求格式不正确' });
      let ws = await deps.store.get(params.data.id);
      if (!ws) return reply.code(404).send({ message: '工作区不存在' });
      const controller = new AbortController();
      const closed = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', closed);
      try {
        if (query.data.sessionId) {
          await assertCapabilityDirectory(ws.dir);
          ws =
            (await deps.runtimeWorkspace?.(ws, { agent: query.data.agent, sessionId: query.data.sessionId })) ??
            (await deps.sessions.assertBelongs(ws, query.data.agent, query.data.sessionId, controller.signal));
        }
        return req.method === 'POST'
          ? await deps.capabilities.refresh(ws, query.data.agent, controller.signal)
          : await deps.capabilities.read(ws, query.data.agent);
      } catch (error) {
        const failure =
          error instanceof SessionError ? error : new SessionError(503, 'capabilities_unavailable', '原生能力读取失败');
        return reply.code(failure.status).send({ code: failure.code, message: failure.message });
      } finally {
        reply.raw.removeListener('close', closed);
      }
    },
  });
}
