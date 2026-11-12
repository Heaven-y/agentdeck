import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AgentKindSchema,
  NativeActionPreviewSchema,
  NativeActionExecuteSchema,
  NativeSessionIdSchema,
} from '@agentdeck/shared/conversation';
import type { createNativeActionsService, NativeActionScope } from '../sessions/native-actions';
import { SessionError } from '../agents/errors';
import { WorkspaceBusyError } from '../workspaces/activity';
const Params = z.strictObject({ id: z.string().min(1), agent: AgentKindSchema, sessionId: NativeSessionIdSchema });
async function respond(reply: FastifyReply, operation: () => Promise<unknown>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof z.ZodError) return reply.code(400).send({ message: '原生操作参数格式不正确。' });
    if (error instanceof SessionError)
      return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof WorkspaceBusyError) return reply.code(409).send({ message: error.message });
    return reply.code(503).send({ message: '原生操作未完成，请重新读取会话和文件状态后核对。' });
  }
}
export function registerNativeActionRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof createNativeActionsService>,
): void {
  const options = {
    bodyLimit: 16_384,
    onRequest: async (_req: unknown, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
    },
  };
  const scope = (params: unknown): NativeActionScope => {
    const { id, ...value } = Params.parse(params);
    return { ...value, workspaceId: id };
  };
  const base = '/api/projects/:id/sessions/:agent/:sessionId/native-actions';
  app.get(base, options, (req, reply) =>
    respond(reply, async () => {
      z.strictObject({}).parse(req.query);
      return service.catalog(scope(req.params));
    }),
  );
  app.post(`${base}/preview`, options, (req, reply) =>
    respond(reply, async () => {
      z.strictObject({}).parse(req.query);
      return service.preview(scope(req.params), NativeActionPreviewSchema.parse(req.body));
    }),
  );
  app.post(`${base}/execute`, options, (req, reply) =>
    respond(reply, async () => {
      z.strictObject({}).parse(req.query);
      return service.execute(scope(req.params), NativeActionExecuteSchema.parse(req.body).token);
    }),
  );
}
