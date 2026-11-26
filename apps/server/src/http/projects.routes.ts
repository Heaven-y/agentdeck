// 项目接口：项目 = 本地目录；管理本地记录，不修改目录和原生会话。
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { WorkspaceInput } from '@agentdeck/shared/projects';
import { WorkspaceStorageError, WorkspaceValidationError, type WorkspaceStore } from '../workspaces/store';
import { WorkspaceBusyError, type WorkspaceActivity } from '../workspaces/activity';
import { FilePreviewError, readWorkspaceFile } from '../workspaces/file-preview';
import { requestSignal } from './request-signal';

const Params = z.object({ id: z.string().min(1) });
const FileQuery = z.object({ path: z.string().min(1).max(4096), view: z.enum(['content', 'diff']).default('content') });
// 名称和目录按需提交；省略的字段保持原值。
const PatchBody = z.object({
  name: z.string().optional(),
  dir: z.string().optional(),
});
type PatchInput = z.infer<typeof PatchBody>;

export type ProjectRoutesDeps = {
  store: WorkspaceStore;
  activity?: WorkspaceActivity;
};

/** 把 store 的字段级校验错误映射成 400 + field，存储损坏统一按 503 上报。 */
async function respond(reply: FastifyReply, operation: () => Promise<unknown>) {
  reply.header('Cache-Control', 'no-store');
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceBusyError)
      return reply.code(409).send({ code: 'project_busy', message: error.message });
    if (error instanceof WorkspaceValidationError)
      return reply.code(400).send({ code: 'invalid_project', message: error.message, field: error.field });
    if (error instanceof WorkspaceStorageError)
      return reply.code(503).send({ code: 'project_storage_failed', message: error.message });
    throw error;
  }
}

function invalid(reply: FastifyReply, message: string) {
  reply.header('Cache-Control', 'no-store');
  return reply.code(400).send({ code: 'invalid_project', message });
}

function missing(reply: FastifyReply) {
  return reply.code(404).send({ code: 'workspace_missing', message: '项目不存在' });
}

/**
 * 只收集请求体里真正出现的键：
 * - { name } 只改名字，目录不动；
 * - { dir } 换目录，需要活动占用门禁。
 */
function toPatch(body: PatchInput): Partial<WorkspaceInput> {
  const patch: Partial<WorkspaceInput> = {};
  if ('name' in body) patch.name = body.name;
  if ('dir' in body) patch.dir = body.dir;
  return patch;
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRoutesDeps): void {
  const listProjects = () => deps.store.list();
  const withIdle = <T>(id: string, operation: () => Promise<T>) =>
    deps.activity ? deps.activity.withIdle(id, operation) : operation();

  app.get('/api/projects', (_req, reply) => respond(reply, listProjects));

  app.get('/api/projects/:id/file', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = Params.safeParse(req.params),
      query = FileQuery.safeParse(req.query);
    if (!params.success || !query.success) return invalid(reply, '文件请求格式不正确。');
    const workspace = await deps.store.get(params.data.id);
    if (!workspace) return missing(reply);
    try {
      return await readWorkspaceFile(
        workspace.dir,
        query.data.path,
        query.data.view === 'diff',
        requestSignal(req, reply),
      );
    } catch (error) {
      if (error instanceof FilePreviewError)
        return reply.code(error.status).send({ code: 'file_preview_failed', message: error.message });
      throw error;
    }
  });

  app.post('/api/projects', (req, reply) => {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))
      return invalid(reply, '项目请求格式不正确');
    // 字段校验交给 store，错误带 field 返回；这里只挡明显不是对象的请求体。
    return respond(reply, () => deps.store.create(req.body as WorkspaceInput));
  });

  app.patch('/api/projects/:id', (req, reply) => {
    const params = Params.safeParse(req.params);
    const body = PatchBody.safeParse(req.body);
    if (!params.success || !body.success) return invalid(reply, '项目修改格式不正确');
    return respond(reply, async () => {
      const update = () => deps.store.update(params.data.id, toPatch(body.data));
      const updated = body.data.dir === undefined ? await update() : await withIdle(params.data.id, update);
      return updated ?? missing(reply);
    });
  });

  app.delete('/api/projects/:id', (req, reply) => {
    const params = Params.safeParse(req.params);
    if (!params.success) return invalid(reply, '项目请求格式不正确');
    return respond(reply, async () => {
      // 删除只移除本工具的配置，不碰项目目录；已打开的终端与面板不会因此被关闭。
      if (!(await withIdle(params.data.id, () => deps.store.remove(params.data.id)))) return missing(reply);
      return reply.code(204).send();
    });
  });
}
