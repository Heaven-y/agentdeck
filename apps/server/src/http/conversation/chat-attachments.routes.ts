import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ATTACHMENT_LIMITS,
  AttachmentScopeSchema,
  AttachmentRefSchema,
  type AttachmentScope,
  type AgentKind,
} from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import type { AttachmentStore } from '../../chat/attachments/attachments';
import type { ResumeHub } from '../../chat/resume-hub';
import { SessionError } from '../../agents/errors';
import { PermissionSelectionSchema, type NativeInteractionFeatures } from '@agentdeck/shared/conversation';
import type { AgentTurnInput } from '../../agents/contracts';
const Owner = z.object({ 'x-agentdeck-owner': z.uuid(), 'x-agentdeck-instance': z.uuid() });
const Params = z.object({ workspaceId: z.string().min(1).max(200), id: z.uuid().optional() });
const Query = AttachmentScopeSchema.omit({ workspaceId: true });
const Upload = Query.extend({ name: z.string().min(1).max(255), mimeType: z.string().max(100) });
const Read = Query.extend({ revision: AttachmentRefSchema.shape.revision });
const FeatureQuery = Query.extend({
  model: z.string().min(1).max(256).optional(),
  permissionMode: z.string().max(40).optional(),
});
type Deps = {
  attachments: AttachmentStore;
  recovery: Pick<ResumeHub, 'identity'>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  assertBelongs(workspace: Workspace, agent: AgentKind, id: string): Promise<unknown>;
  acquireWorkspace(id: string): () => void;
  inputFeatures?(agent: AgentKind, input: AgentTurnInput, signal: AbortSignal): Promise<NativeInteractionFeatures>;
};
async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  try {
    return await action();
  } catch (error) {
    if (error instanceof SessionError)
      return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ code: 'attachment_invalid', message: '附件请求格式不正确。' });
    return reply
      .code(400)
      .send({ code: 'attachment_unavailable', message: '附件当前不可用，请重新选择或检查项目状态。' });
  }
}
export function registerChatAttachmentRoutes(app: FastifyInstance, deps: Deps): void {
  async function context<T extends z.ZodType<{ agent: AgentKind; conversationId: string; sessionId?: string }>>(
    req: FastifyRequest,
    schema: T,
  ) {
    const params = Params.parse(req.params);
    const query = schema.parse(req.query);
    const headers = Owner.parse(req.headers);
    const owner = deps.recovery.identity(headers['x-agentdeck-owner'], headers['x-agentdeck-instance']);
    if (!owner) throw new SessionError(409, 'attachment_owner_missing', '页面连接已变化，请重新连接后选择附件。');
    const release = deps.acquireWorkspace(params.workspaceId);
    try {
      const workspace = await deps.getWorkspace(params.workspaceId);
      if (!workspace) throw new SessionError(404, 'workspace_missing', '工作区不存在');
      if (query.sessionId) await deps.assertBelongs(workspace, query.agent, query.sessionId);
      const scope: AttachmentScope = {
        workspaceId: params.workspaceId,
        agent: query.agent,
        conversationId: query.conversationId,
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      };
      return { params, query, owner, scope, workspace, release };
    } catch (error) {
      release();
      throw error;
    }
  }
  void app.register((scope, _options, done) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    const base = '/api/workspaces/:workspaceId/chat-attachments';
    scope.post('/api/workspaces/:workspaceId/chat-input-capabilities', (req, reply) =>
      respond(reply, async () => {
        const c = await context(req, FeatureQuery);
        try {
          if (!deps.inputFeatures) throw new SessionError(503, 'attachment_unavailable', '当前附件能力不可用。');
          const permission = c.query.permissionMode
            ? PermissionSelectionSchema.parse({ agent: c.scope.agent, mode: c.query.permissionMode })
            : undefined;
          return await deps.inputFeatures(
            c.scope.agent,
            {
              workspace: c.workspace,
              sessionId: c.scope.sessionId,
              model: c.query.model,
              permission,
              text: '',
              emit: () => {},
              requestPermission: () => Promise.resolve({ allow: false }),
            },
            AbortSignal.timeout(30_000),
          );
        } finally {
          c.release();
        }
      }),
    );
    scope.post(base, { bodyLimit: ATTACHMENT_LIMITS.fileBytes }, (req, reply) =>
      respond(reply, async () => {
        const c = await context(req, Upload);
        try {
          if (!Buffer.isBuffer(req.body)) throw new SessionError(400, 'attachment_invalid', '附件必须通过二进制上传。');
          return await deps.attachments.upload(c.owner, c.scope, {
            name: c.query.name,
            mimeType: c.query.mimeType,
            data: req.body,
          });
        } finally {
          c.release();
        }
      }),
    );
    scope.get(`${base}/:id`, (req, reply) =>
      respond(reply, async () => {
        const c = await context(req, Read);
        try {
          const asset = await deps.attachments.preview(c.owner, c.scope, {
            id: c.params.id!,
            revision: c.query.revision,
          });
          reply.type(asset.mimeType);
          if (asset.kind !== 'image')
            reply.header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(asset.name));
          return reply.send(asset.data);
        } finally {
          c.release();
        }
      }),
    );
    scope.delete(`${base}/:id`, (req, reply) =>
      respond(reply, async () => {
        const c = await context(req, Read);
        try {
          await deps.attachments.remove(c.owner, c.scope, { id: c.params.id!, revision: c.query.revision });
          return { deleted: true };
        } finally {
          c.release();
        }
      }),
    );
    done();
  });
}
