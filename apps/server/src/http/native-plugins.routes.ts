import type { FastifyInstance, FastifyReply, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import { NativePluginPrepareSchema, NativePluginStartSchema } from '@agentdeck/shared/settings';
import type { NativePluginService } from '../native-management/plugin-service';
import { NativeResourceError } from '../agents/common/configuration/errors';
import { SessionError } from '../agents/errors';
import { WorkspaceBusyError } from '../workspaces/activity';
import { managementError } from '../native-management/errors';
import { PluginError } from '../native-management/plugin-errors';
import type { WorkspaceStore } from '../workspaces/store';
const Params = z.object({ agent: z.enum(['claude', 'codex', 'antigravity']) }).strict();
const Query = z.object({ projectId: z.string().min(1).max(128).optional() }).strict();
const Identity = z
  .object({ id: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const Operation = z.object({ operationId: z.string().uuid() }).strict();
async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SessionError || error instanceof PluginError)
      return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof WorkspaceBusyError)
      return reply.code(409).send({ code: 'project_busy', message: error.message });
    const failure = managementError(error);
    return reply.code(failure.status).send({ code: failure.code, message: failure.message });
  }
}
export function registerNativePluginRoutes(
  app: FastifyInstance,
  deps: { service: NativePluginService; store: Pick<WorkspaceStore, 'get'> },
) {
  const options: RouteShorthandOptions = {
    bodyLimit: 128 * 1024,
    onSend: async (_req, reply, payload) => {
      reply.header('Cache-Control', 'no-store');
      return payload;
    },
    errorHandler: (_error, _req, reply) => {
      const e = new NativeResourceError('invalid_request');
      void reply.code(e.status).send({ code: e.code, message: e.message });
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
  const base = '/api/native-management/:agent/plugins';
  app.get(base, options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query);
      return deps.service.read(agent, project);
    }),
  );
  app.post(base + '/prepare', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query),
        input = NativePluginPrepareSchema.safeParse(req.body);
      if (!input.success) throw new NativeResourceError('invalid_request');
      return deps.service.prepare(agent, input.data, project);
    }),
  );
  app.post(base + '/start', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query),
        input = NativePluginStartSchema.safeParse(req.body);
      if (!input.success) throw new NativeResourceError('invalid_request');
      return deps.service.start(agent, input.data, project);
    }),
  );
  app.post(base + '/detail', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query),
        input = Identity.safeParse(req.body);
      if (!input.success) throw new NativeResourceError('invalid_request');
      return deps.service.detail(agent, input.data.id, input.data.revision, project);
    }),
  );
  for (const action of ['operation', 'cancel'] as const)
    app.post(base + '/' + action, options, (req, reply) =>
      respond(reply, async () => {
        const { agent, project } = await context(req.params, req.query),
          input = Operation.safeParse(req.body);
        if (!input.success) throw new NativeResourceError('invalid_request');
        return deps.service[action](agent, project, input.data.operationId);
      }),
    );
}
