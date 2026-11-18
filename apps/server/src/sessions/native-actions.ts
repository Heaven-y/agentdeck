import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import type {
  AgentKind,
  NativeAction,
  NativeActionCatalog,
  NativeActionPreview,
  NativeActionPreviewSchema,
  NativeActionResult,
} from '@agentdeck/shared/conversation';
import type { Workspace } from '@agentdeck/shared/projects';
import type { NativeActionBackend, NativeActionInspection } from '../agents/common/interaction/native-actions';
import { SessionError } from '../agents/errors';
import { readBoundedFile } from '../platform/files/bounded-file';
import { inspectDirectory, assertDirectoryUnchanged } from '../platform/files/safe-file';

export type NativeActionScope = { workspaceId: string; agent: AgentKind; sessionId: string };
type Deps = {
  withSession<T>(scope: NativeActionScope, operation: (ws: Workspace) => Promise<T>): Promise<T>;
  open(scope: NativeActionScope, ws: Workspace): Promise<NativeActionBackend>;
  changed(agent: AgentKind): Promise<void>;
};
type Preview = {
  scope: NativeActionScope;
  preview: NativeActionPreview;
  revision: string;
  signature: string;
  promise?: Promise<NativeActionResult>;
  settled?: boolean;
};
const failure = (message: string) => new SessionError(409, 'native_action_conflict', message);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actionFor = (agent: AgentKind): NativeAction => (agent === 'claude' ? 'rewind-files' : 'revert-history');
export function createNativeActionsService(deps: Deps) {
  const previews = new Map<string, Preview>();
  async function withBackend<T>(
    scope: NativeActionScope,
    operation: (backend: NativeActionBackend, ws: Workspace) => Promise<T>,
  ): Promise<T> {
    if (scope.agent === 'antigravity') throw failure('当前原生接口没有已核实的回退操作。');
    return deps.withSession(scope, async (ws) => {
      const backend = await deps.open(scope, ws);
      try {
        return await operation(backend, ws);
      } finally {
        await backend.close();
      }
    });
  }
  function prune() {
    for (const [token, value] of previews)
      if (value.preview.expiresAt <= Date.now() && (!value.promise || value.settled)) previews.delete(token);
  }
  async function inspect(
    backend: NativeActionBackend,
    ws: Workspace,
    pointId: string,
  ): Promise<{ value: NativeActionInspection; signature: string; files: string[] }> {
    const value = await backend.inspect(pointId);
    const files = await fileSnapshot(ws.dir, value.files);
    return { value, files: files.map((file) => file.name), signature: hash([value.signature, files]) };
  }
  async function execute(entry: Preview): Promise<NativeActionResult> {
    return withBackend(entry.scope, async (backend, ws) => {
      const state = await backend.read();
      if (state.revision !== entry.revision) throw failure('原生会话已变化，请重新预览。');
      const checked = await inspect(backend, ws, entry.preview.pointId);
      if (checked.signature !== entry.signature) throw failure('文件或原生预览已变化，请重新预览。');
      let result: NativeActionResult;
      try {
        result = await backend.execute(entry.preview.pointId);
      } catch {
        result = { status: 'unknown', message: '原生操作结果未确认，请重新读取历史与文件；不会自动重试。' };
      }
      try {
        await deps.changed(entry.scope.agent);
      } catch {
        return { status: 'partial', message: `${result.message} 运行实例刷新未完成，请结束其他任务后重新启动CLI。` };
      }
      return result;
    });
  }
  return {
    async catalog(scope: NativeActionScope): Promise<NativeActionCatalog> {
      return withBackend(scope, async (backend) => {
        const state = await backend.read();
        return {
          ...state,
          action: actionFor(scope.agent),
          available: state.candidates.length > 0,
          reason: state.candidates.length ? undefined : '没有可验证的原生回退位置。',
        };
      });
    },
    async preview(
      scope: NativeActionScope,
      input: z.infer<typeof NativeActionPreviewSchema>,
    ): Promise<NativeActionPreview> {
      prune();
      if (previews.size >= 128) throw failure('待确认操作达到上限，请稍后重试。');
      if (input.action !== actionFor(scope.agent)) throw failure('回退类型不属于此CLI。');
      return withBackend(scope, async (backend, ws) => {
        const state = await backend.read();
        if (state.revision !== input.revision || !state.candidates.some((point) => point.id === input.pointId))
          throw failure('原生会话或回退位置已变化，请刷新后重试。');
        const checked = await inspect(backend, ws, input.pointId);
        if (previews.size >= 128) throw failure('待确认操作达到上限，请稍后重试。');
        const preview: NativeActionPreview = {
          token: randomUUID(),
          action: input.action,
          pointId: input.pointId,
          files: checked.files,
          removesTurns: checked.value.removesTurns,
          expiresAt: Date.now() + 300_000,
          notice:
            input.action === 'rewind-files'
              ? '恢复原生检查点记录的文件；会话历史保留。'
              : '删除此轮及之后的原生会话历史；工作区文件保留。',
        };
        previews.set(preview.token, {
          scope: { ...scope },
          preview,
          revision: state.revision,
          signature: checked.signature,
        });
        return preview;
      });
    },
    async execute(scope: NativeActionScope, token: string): Promise<NativeActionResult> {
      const entry = previews.get(token);
      if (!entry || hash(entry.scope) !== hash(scope)) throw failure('预览不属于此会话或已失效。');
      if (entry.promise) return entry.promise;
      if (entry.preview.expiresAt <= Date.now()) {
        previews.delete(token);
        throw failure('预览已过期，请重新预览。');
      }
      entry.promise = execute(entry).finally(() => {
        entry.settled = true;
        entry.preview.expiresAt = Date.now() + 30 * 60_000;
      });
      return entry.promise;
    },
  };
}
async function snapshotFile(root: string, file: string, limit: number) {
  if (!path.isAbsolute(file)) throw failure('原生回退文件没有完整路径，无法安全预览。');
  const directories = await inspectDirectory(path.dirname(file));
  if (!directories) throw failure('原生回退文件目录不存在，请在原生CLI中核对。');
  const parent = await realpath(path.dirname(file));
  const name = path.relative(root, path.join(parent, path.basename(file)));
  if (!name || name === '..' || name.startsWith(`..${path.sep}`) || path.isAbsolute(name))
    throw failure('原生回退涉及工作区之外的文件，请在原生CLI中核对。');
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) {
    await assertDirectoryUnchanged(directories);
    return { name, digest: 'missing', size: 0 };
  }
  const data = await readBoundedFile(file, Math.min(10 * 1024 * 1024, limit));
  return { name, digest: createHash('sha256').update(data).digest('hex'), size: data.length };
}
async function fileSnapshot(directory: string, paths: string[]): Promise<Array<{ name: string; digest: string }>> {
  if (paths.length > 128) throw failure('回退涉及文件过多，请在原生CLI中核对。');
  const root = await realpath(directory),
    files: Array<{ name: string; digest: string }> = [];
  let total = 0;
  for (const file of paths) {
    const snapshot = await snapshotFile(root, file, 32 * 1024 * 1024 - total);
    total += snapshot.size;
    files.push({ name: snapshot.name, digest: snapshot.digest });
  }
  return files;
}
