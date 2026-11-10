import type { FastifyInstance, FastifyReply, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import { NativeMcpSaveSchema, NativeMcpOperateSchema } from '@agentdeck/shared/settings';
import type { NativeMcpService } from '../native-management/mcp-service';
import type { McpControlService } from '../native-management/mcp-control-service';
import { NativeResourceError } from '../agents/common/configuration/errors';
import { SessionError } from '../agents/errors';
import { WorkspaceBusyError } from '../workspaces/activity';
import { managementError } from '../native-management/errors';
import type { WorkspaceStore } from '../workspaces/store';
const Params = z.object({ agent: z.enum(['claude', 'codex', 'antigravity']) }).strict();
const Query = z.object({ projectId: z.string().min(1).max(128).optional() }).strict();
const Control = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    instanceId: z.string().uuid().optional(),
    cursor: z.string().max(8192).optional(),
    action: z.enum(['check', 'reconnect', 'runtime-enable', 'runtime-disable', 'login']),
  })
  .strict();
const OAuth = z
  .object({
    id: z.string().uuid(),
    action: z.enum(['read', 'cancel']),
  })
  .strict();
async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SessionError)
      return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof WorkspaceBusyError)
      return reply.code(409).send({ code: 'project_busy', message: error.message });
    const failure = managementError(error);
    return reply.code(failure.status).send({ code: failure.code, message: failure.message });
  }
}
export function registerNativeMcpRoutes(
  app: FastifyInstance,
  deps: { service: NativeMcpService; controls: McpControlService; store: Pick<WorkspaceStore, 'get'> },
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
  const base = '/api/native-management/:agent/mcp';
  app.get(base, options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query);
      return {
        ...(await deps.service.readMcp(agent, project)),
        instances: deps.controls.instances(agent, project),
        operations: deps.controls.oauth.list(agent, project?.id),
      };
    }),
  );
  app.post(base + '/save', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query);
      const input = NativeMcpSaveSchema.safeParse(req.body);
      if (!input.success) throw new NativeResourceError('invalid_request');
      return deps.service.saveMcp(agent, input.data, project);
    }),
  );
  app.post(base + '/change', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query);
      const input = NativeMcpOperateSchema.safeParse(req.body);
      if (!input.success) throw new NativeResourceError('invalid_request');
      return deps.service.operateMcp(agent, input.data, project);
    }),
  );
  app.post(base + '/control', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query);
      const input = Control.safeParse(req.body);
      if (!input.success) throw new NativeResourceError('invalid_request');
      return deps.controls.operate(agent, input.data, project);
    }),
  );
  app.post(base + '/oauth', options, (req, reply) =>
    respond(reply, async () => {
      const { agent, project } = await context(req.params, req.query),
        input = OAuth.safeParse(req.body);
      if (!input.success) throw new NativeResourceError('invalid_request');
      const { id, action } = input.data;
      if (action === 'read') return deps.controls.oauth.get(agent, project?.id, id);
      return deps.controls.oauth.cancel(agent, project?.id, id);
    }),
  );
}
