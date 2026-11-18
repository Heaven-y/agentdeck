import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeSessionIdSchema } from '@agentdeck/shared/conversation';
import { SessionError } from '../../errors';
import { sameSessionDirectory } from '../../common/history/session-scope';
import { nativeSessionDirectory } from '../../common/history/session-ownership';
import type { AntigravitySessionManagement, SubagentTrajectoryIdentity } from '../history/session-management-types';
import { startManagementBackend } from './management-process';
import { completeTrajectory } from '../history/trajectory-read';
import {
  managementFailure,
  NativeTrajectoryMissing,
  managementObject as object,
  managementText as text,
  type ManagementBackend,
  type ManagementRecord,
} from './management-rpc';

type Options = {
  environment?: () => Promise<NodeJS.ProcessEnv>;
  env?: NodeJS.ProcessEnv;
  geminiDir?: string;
  /** 合成运行时与摘要检查注入，不向 HTTP 暴露地址或原生存储路径。 */
  backend?: (dir: string, signal?: AbortSignal) => Promise<ManagementBackend>;
  summaryReady?: (id: string) => boolean;
  summaryMatches?: (id: string, dir: string) => Promise<boolean>;
};

function assertId(id: unknown): asserts id is string {
  if (!NativeSessionIdSchema.safeParse(id).success) throw managementFailure();
}
function missing() {
  return new SessionError(404, 'session_missing', 'Antigravity 在当前存储中没有此会话。');
}
function directories(metadata: ManagementRecord): string[] {
  if (Array.isArray(metadata.workspaceUris))
    return metadata.workspaceUris.filter((value): value is string => typeof value === 'string');
  return Array.isArray(metadata.workspaces)
    ? metadata.workspaces.map((value) => text(object(value).workspaceFolderAbsoluteUri)).filter(Boolean)
    : [];
}
async function assertDirectory(metadata: ManagementRecord, dir: string) {
  const uris = [...new Set(directories(metadata))];
  if (uris.length !== 1) throw missing();
  let directory: string;
  try {
    directory = fileURLToPath(uris[0]!);
  } catch {
    throw missing();
  }
  if (!(await sameSessionDirectory(directory, dir))) throw missing();
}

type RunOptions = {
  recoverDelete?: boolean;
  full?: boolean;
  stable?: boolean;
  signal?: AbortSignal;
  readOnly?: boolean;
  child?: SubagentTrajectoryIdentity;
};
function assertReadIdentity(metadata: ManagementRecord, rootId: string, child?: SubagentTrajectoryIdentity) {
  if (child) {
    if (
      metadata.parentConversationId !== child.parentId ||
      metadata.rootConversationId !== rootId ||
      metadata.nestingDepth !== child.depth
    )
      throw missing();
    return;
  }
  if (
    metadata.parentConversationId ||
    Number(metadata.nestingDepth ?? 0) !== 0 ||
    (metadata.rootConversationId && metadata.rootConversationId !== rootId)
  )
    throw missing();
}
function assertReadChild(rootId: string, child?: SubagentTrajectoryIdentity) {
  if (
    child &&
    (child.rootId !== rootId ||
      child.id === rootId ||
      !Number.isSafeInteger(child.depth) ||
      child.depth < 1 ||
      child.depth > 10)
  )
    throw missing();
}
async function checkedReadOnly(backend: ManagementBackend, rootId: string, dir: string, options: RunOptions) {
  const child = options.child;
  const id = child?.id ?? rootId;
  assertId(id);
  assertReadChild(rootId, child);
  const response = await backend.request('GetCascadeTrajectory', {
    cascadeId: id,
    trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_FULL',
  });
  const trajectory = object(response.trajectory);
  const metadata = object(trajectory.metadata);
  if (trajectory.cascadeId !== id) throw missing();
  await assertDirectory(metadata, dir);
  assertReadIdentity(metadata, rootId, child);
  options.signal?.throwIfAborted();
  return { trajectory: await completeTrajectory(backend, response, options.signal), status: text(response.status) };
}
async function idleTrajectory(result: ManagementRecord, id: string, dir: string): Promise<ManagementRecord> {
  const trajectory = object(result.trajectory);
  if (trajectory.cascadeId !== id) throw missing();
  const metadata = object(trajectory.metadata);
  await assertDirectory(metadata, dir);
  if (metadata.parentConversationId || Number(metadata.nestingDepth ?? 0) > 0)
    throw new SessionError(400, 'unsupported_action', '不能单独管理 Antigravity 内部子代理会话。');
  if (result.status !== 'CASCADE_RUN_STATUS_IDLE')
    throw new SessionError(409, 'session_busy', 'Antigravity 会话尚未空闲，请结束后再管理。');
  return trajectory;
}

function unstableTurnTrajectory(): never {
  throw new SessionError(503, 'session_history_incomplete', 'Antigravity 本轮轨迹未完整读取，请核对原生会话。');
}

async function recheckTurnPages(
  backend: ManagementBackend,
  scope: { id: string; dir: string },
  snapshot: { steps: unknown; total: unknown },
): Promise<void> {
  // 分页不是原子读取；补页后复核身份、空闲状态、步骤总数和首包内容。
  const latest = await backend.request('GetCascadeTrajectory', {
    cascadeId: scope.id,
    trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_FULL',
  });
  const rechecked = await idleTrajectory(latest, scope.id, scope.dir);
  if (latest.numTotalSteps !== snapshot.total || !isDeepStrictEqual(rechecked.steps, snapshot.steps))
    unstableTurnTrajectory();
}

async function checked(backend: ManagementBackend, id: string, dir: string, options: RunOptions = {}) {
  const result = await backend.request('GetCascadeTrajectory', {
    cascadeId: id,
    ...(options.full ? { trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_FULL' } : {}),
  });
  const trajectory = await idleTrajectory(result, id, dir);
  if (!options.full) return trajectory;
  const total = result.numTotalSteps;
  if (options.stable && !Number.isSafeInteger(total)) unstableTurnTrajectory();
  const complete = await completeTrajectory(backend, result, options.signal);
  const firstPage = Array.isArray(trajectory.steps) ? trajectory.steps.length : 0;
  if (options.stable && firstPage !== total)
    await recheckTurnPages(backend, { id, dir }, { steps: trajectory.steps, total });
  return complete;
}

/** 原生摘要异步落库：只检查指定 ID，失败不伪装成“尚未创建”。 */
function summaryExists(file: string, id: string): boolean {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return !!db.prepare('select conversation_id from conversation_summaries where conversation_id = ?').get(id);
  } finally {
    db.close();
  }
}
async function summaryMatches(file: string, id: string, dir: string): Promise<boolean> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('select workspace_uris from conversation_summaries where conversation_id = ?').get(id);
    const native = nativeSessionDirectory({ workspaceUris: text(row?.workspace_uris) });
    return !!native && (await sameSessionDirectory(native, dir));
  } finally {
    db.close();
  }
}
async function awaitSummary(id: string, ready: (id: string) => boolean) {
  const deadline = Date.now() + 2000;
  while (!ready(id)) {
    if (Date.now() >= deadline)
      throw new SessionError(503, 'session_runtime_failed', '原生分支已创建，摘要尚未就绪；稍后重新读取列表核对。');
    await delay(40);
  }
}
async function clearSummary(backend: ManagementBackend, id: string, ready: (id: string) => boolean) {
  const deadline = Date.now() + 2000;
  do {
    await backend.request('JetboxDeleteSummary', { cascadeId: id });
    // 原生摘要同步是异步的；确认索引已移除后才结束管理进程。
    await delay(40);
    if (!ready(id)) return;
  } while (Date.now() < deadline);
  throw new SessionError(503, 'session_runtime_failed', '原生会话已删除，摘要清理尚未确认；请重试删除以完成清理。');
}

function forkPoint(trajectory: ManagementRecord, requested?: string): number {
  if (!Array.isArray(trajectory.steps) || !trajectory.steps.length)
    throw new SessionError(400, 'invalid_fork_point', 'Antigravity 会话还没有可用于分支的消息。');
  const point =
    requested === undefined ? trajectory.steps.length - 1 : /^\d+$/.test(requested) ? Number(requested) : -1;
  if (!Number.isSafeInteger(point) || point < 0 || point >= trajectory.steps.length)
    throw new SessionError(400, 'invalid_fork_point', 'Antigravity 原生分支位置无效。');
  const status = text(object(trajectory.steps[point]).status);
  if (status !== 'CORTEX_STEP_STATUS_DONE') throw new SessionError(409, 'session_busy', '所选原生步骤尚未完成。');
  if (object(trajectory.steps[point]).type === 'CORTEX_STEP_TYPE_USER_INPUT')
    throw new SessionError(400, 'invalid_fork_point', '请从已有回复之后创建分支，最后一条用户消息还没有回复。');
  return point;
}

/** 只借助 agy 自身存储操作；不手动复制轨迹、改 SQLite，亦不发送模型消息。 */
export function createAntigravitySessionManagement(
  options: Options = {},
): AntigravitySessionManagement & { dispose(): Promise<void> } {
  const controller = new AbortController();
  const active = new Set<ManagementBackend>();
  const starting = new Set<Promise<ManagementBackend>>();
  const geminiDir = path.resolve(options.geminiDir ?? path.join(homedir(), '.gemini'));
  const summaryFile = path.join(geminiDir, 'antigravity-cli', 'conversation_summaries.db');
  const matches = options.summaryMatches ?? ((id: string, dir: string) => summaryMatches(summaryFile, id, dir));
  const ready = options.summaryReady ?? ((id: string) => summaryExists(summaryFile, id));
  const start =
    options.backend ??
    (async (dir: string, signal?: AbortSignal) =>
      startManagementBackend({
        cwd: dir,
        geminiDir,
        signal,
        env: (await options.environment?.()) ?? options.env ?? process.env,
      }));
  async function checkOrRecover(backend: ManagementBackend, id: string, dir: string, runOptions: RunOptions) {
    if (runOptions.readOnly) return checkedReadOnly(backend, id, dir, runOptions);
    try {
      return await checked(backend, id, dir, runOptions);
    } catch (error) {
      if (!runOptions.recoverDelete || !(error instanceof NativeTrajectoryMissing) || !(await matches(id, dir)))
        throw error;
      return {};
    }
  }
  function assertActive(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (controller.signal.aborted) throw managementFailure();
  }
  async function run<T>(
    id: string,
    dir: string,
    action: (backend: ManagementBackend, trajectory: ManagementRecord) => Promise<T>,
    runOptions: RunOptions = {},
  ) {
    assertId(id);
    assertActive(runOptions.signal);
    if (!path.isAbsolute(dir)) throw missing();
    // 本次读取预算必须覆盖后端初始化，不能等启动完成后才传入取消信号。
    const signal = runOptions.signal ? AbortSignal.any([controller.signal, runOptions.signal]) : controller.signal;
    const pending = start(dir, signal);
    starting.add(pending);
    let backend: ManagementBackend;
    try {
      backend = await pending;
    } finally {
      starting.delete(pending);
    }
    active.add(backend);
    const abort = () => void backend.close().catch(() => undefined);
    runOptions.signal?.addEventListener('abort', abort, { once: true });
    try {
      assertActive(runOptions.signal);
      const trajectory = await checkOrRecover(backend, id, dir, runOptions);
      runOptions.signal?.throwIfAborted();
      return await action(backend, trajectory);
    } finally {
      runOptions.signal?.removeEventListener('abort', abort);
      await backend.close();
      active.delete(backend);
    }
  }
  return {
    readSubagentTrajectory: (id, dir, child, signal) =>
      run(id, dir, (_backend, result) => Promise.resolve(result as { trajectory: ManagementRecord; status?: string }), {
        readOnly: true,
        child,
        signal,
      }),
    readTrajectory: (id, dir, signal) =>
      run(id, dir, (_backend, trajectory) => Promise.resolve({ trajectory }), { full: true, signal }),
    readTurnTrajectory: (id, dir, signal) =>
      run(id, dir, (_backend, trajectory) => Promise.resolve({ trajectory }), { full: true, stable: true, signal }),
    async dispose() {
      controller.abort();
      const close = Promise.allSettled([
        ...[...active].map((backend) => backend.close()),
        ...[...starting].map((pending) => pending.then((backend) => backend.close())),
      ]);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        close,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 6500);
        }),
      ]);
      clearTimeout(timer);
    },
    rename: (id, dir, title) =>
      run(id, dir, async (backend) => {
        if (!title.trim() || title.length > 200) throw new SessionError(400, 'invalid_request', '会话名称无效。');
        await backend.request('UpdateConversationAnnotations', {
          cascadeId: id,
          annotations: { title: title.trim() },
          mergeAnnotations: true,
        });
      }),
    delete: (id, dir) =>
      run(
        id,
        dir,
        async (backend, trajectory) => {
          if (trajectory.cascadeId) {
            await backend.request('DeleteCascadeTrajectory', { cascadeId: id });
            try {
              await backend.request('GetCascadeTrajectory', { cascadeId: id });
              throw managementFailure();
            } catch (error) {
              if (!(error instanceof NativeTrajectoryMissing)) throw error;
            }
          }
          await clearSummary(backend, id, ready);
        },
        { recoverDelete: true },
      ),
    fork: (id, dir, input) =>
      run(id, dir, async (backend, trajectory) => {
        const point = forkPoint(trajectory, input.pointId);
        const response = await backend.request('ForkConversation', {
          sourceCascadeId: id,
          forkAtStepIndex: point,
          targetForkWorkspace: 'FORK_TARGET_CURRENT_WORKSPACE',
          sourceWorkspaceUris: [pathToFileURL(dir).href],
        });
        const created = response.newCascadeId;
        assertId(created);
        if (created === id) throw managementFailure();
        const copy = await checked(backend, created, dir);
        const references = Array.isArray(copy.parentReferences) ? copy.parentReferences : [];
        if (
          !references.some(
            (value) => object(value).conversationId === id && Number(object(value).stepIndex ?? 0) === point,
          )
        )
          throw managementFailure();
        await awaitSummary(created, ready);
        return { sessionId: created };
      }),
  };
}
