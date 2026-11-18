import { AgentKindSchema } from '@agentdeck/shared/conversation';
import type { FastifyInstance, FastifyReply, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import { NativeResourceError } from '../../agents/common/configuration/errors';
import { SessionError } from '../../agents/errors';
import { managementError } from '../../native-management/errors';
import type { NativeManagementService } from '../../native-management/skills/service';
import { SKILL_LIMITS } from '../../native-management/skills/skill-tree';
import { WorkspaceBusyError } from '../../workspaces/activity';
import type { WorkspaceStore } from '../../workspaces/store';

const Params = z.object({ agent: AgentKindSchema }).strict();
const Query = z.object({ projectId: z.string().min(1).max(128).optional() }).strict();
const Id = z.string().regex(/^[a-f0-9]{64}$/);
const Change = z
  .object({
    id: Id,
    revision: Id,
    action: z.enum(['state', 'delete']),
    value: z
      .enum(['inherit', 'on', 'name-only', 'user-invocable-only', 'off', 'enabled', 'disabled', 'unknown'])
      .optional(),
    scope: z.enum(['user', 'project', 'local', 'directory']).optional(),
    confirmation: z.string().max(200).optional(),
  })
  .strict();
const Import = z
  .object({
    rootId: Id,
    name: z.string().min(1).max(64),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            contentBase64: z.string().max(Math.ceil(SKILL_LIMITS.fileBytes / 3) * 4),
          })
          .strict(),
      )
      .min(1)
      .max(SKILL_LIMITS.files),
  })
  .strict();
type Deps = { service: NativeManagementService; store: Pick<WorkspaceStore, 'get'> };
async function respond(reply: FastifyReply, operation: () => Promise<unknown>) {
  reply.header('Cache-Control', 'no-store');
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SessionError)
      return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof WorkspaceBusyError)
      return reply.code(409).send({ code: 'project_busy', message: error.message });
    const failure = managementError(error);
    return reply.code(failure.status).send({ code: failure.code, message: failure.message });
  }
}
export function registerNativeManagementRoutes(app: FastifyInstance, deps: Deps) {
  const options: RouteShorthandOptions = {
    bodyLimit: Math.ceil((SKILL_LIMITS.bytes * 4) / 3) + 128 * 1024,
    onSend: async (_req, reply, payload) => {
      reply.header('Cache-Control', 'no-store');
      return payload;
    },
    errorHandler: (error, _req, reply) => {
      const failure = new NativeResourceError(error.statusCode === 413 ? 'too_large' : 'invalid_request');
      void reply.code(failure.status).send({ code: failure.code, message: failure.message });
    },
  };
  async function context(params: unknown, query: unknown) {
    const a = Params.safeParse(params),
      q = Query.safeParse(query);
    if (!a.success || !q.success) throw new NativeResourceError('invalid_request');
    const project = q.data.projectId ? await deps.store.get(q.data.projectId) : undefined;
    if (q.data.projectId && !project) throw new NativeResourceError('project_missing');
    return { agent: a.data.agent, project };
  }
  app.get('/api/native-management/:agent/skills', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query);
      return deps.service.readSkills(agent, project);
    }),
  );
  app.post('/api/native-management/:agent/skills/change', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query);
      const body = Change.safeParse(req.body);
      if (!body.success) throw new NativeResourceError('invalid_request');
      return deps.service.changeSkill(agent, body.data, project);
    }),
  );
  app.post('/api/native-management/:agent/skills/import', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query);
      const body = Import.safeParse(req.body);
      if (!body.success) throw new NativeResourceError('invalid_request');
      return deps.service.importSkill(agent, body.data, project);
    }),
  );
}
