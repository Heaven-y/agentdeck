import { randomUUID } from 'node:crypto';
import { NativeSessionIdSchema } from '@agentdeck/shared/conversation';
import { z } from 'zod';
import { SessionError } from '../../errors';
import { historyPageIncomplete, NativeHistoryPageTooLarge, NativeHistoryPagingUnavailable } from './history-stream';
import { managementObject as object, type ManagementBackend, type ManagementRecord } from './management-rpc';
import { assertDirectory, missing } from './trajectory-scope';

const PAGE_TURNS = 3;
const PAGE_STEPS = 96;
const MEDIA_STEP_BYTES = 32 * 1024 * 1024;
const GENERATORS_PAGE_BYTES = 4 * 1024 * 1024;
const EMPTY_WINDOW = { start: 0, end: 0 };
export const OMITTED_HISTORY_STEP = 'AGENTDECK_HISTORY_STEP_OMITTED';

type Range = { start: number; end: number };
type Scope = { id: string; dir: string };
type HistoryPageRequest = Range & { compact?: boolean; generators?: Range; limit?: number };
type NativeSnapshot = { trajectoryId: string; total: number; turns: number[]; generators: number; status: unknown };
export type HistoryWindow = {
  trajectory: ManagementRecord;
  page: { start: number; before?: string };
  partialStart: boolean;
  partialEnd: boolean;
  compact: boolean;
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const index = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bounds = (start: number, end: number) => ({ startIndex: start, endIndexExclusive: end });
const changed = () => new SessionError(409, 'session_history_changed', '原生会话历史已变化，请重新打开会话。');

const cursorSchema = z.tuple([
  NativeSessionIdSchema,
  NativeSessionIdSchema,
  z.int().positive(),
  z.int().positive(),
  z.boolean(),
]);

function decodeCursor(raw: string) {
  try {
    const cursor = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (cursor.success) {
      const [id, trajectoryId, before, total, turnBoundary] = cursor.data;
      if (before < total) return { id, trajectoryId, before, total, turnBoundary };
    }
  } catch {
    // 游标只用于定位历史页，不向原生转发未解析的内容。
  }
  throw new SessionError(400, 'invalid_request', '历史分页游标无效。');
}

async function assertRootDirectory(meta: ManagementRecord, scope: Scope) {
  if (
    meta.parentConversationId ||
    Number(meta.nestingDepth ?? 0) ||
    (meta.rootConversationId && meta.rootConversationId !== scope.id)
  )
    throw missing();
  await assertDirectory(meta, scope.dir);
}

async function requestWindow(backend: ManagementBackend, scope: Scope, input: HistoryPageRequest) {
  if (!backend.readInitialUpdate) throw new NativeHistoryPagingUnavailable();
  const update = await backend.readInitialUpdate(
    {
      conversationId: scope.id,
      subscriberId: randomUUID(),
      initialStepsPageBounds: bounds(input.start, input.end),
      initialGeneratorMetadatasPageBounds: bounds(input.generators?.start ?? 0, input.generators?.end ?? 0),
      initialExecutorMetadatasPageBounds: bounds(0, 0),
      trajectoryVerbosity: input.compact ? 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI' : 'CLIENT_TRAJECTORY_VERBOSITY_FULL',
    },
    input.limit,
  );
  const trajectoryId = NativeSessionIdSchema.safeParse(update.trajectoryId);
  if (update.conversationId !== scope.id || !trajectoryId.success) throw missing();
  const trajectory = object(update.mainTrajectoryUpdate);
  await assertRootDirectory(object(trajectory.metadata), scope);
  return { update, trajectory, trajectoryId: trajectoryId.data, steps: object(trajectory.stepsUpdate) };
}

function windowEntries(page: ManagementRecord, range: Range, key: string) {
  const size = range.end - range.start;
  const actual = object(page.pageBounds);
  const indices = list(page.indices);
  const entries = list(page[key]);
  if (
    (actual.startIndex ?? 0) !== range.start ||
    actual.endIndexExclusive !== range.end ||
    entries.length !== size ||
    indices.length !== size ||
    indices.some((value, n) => value !== range.start + n)
  )
    throw historyPageIncomplete();
  return entries;
}
function windowSteps(page: ManagementRecord, range: Range) {
  const steps = windowEntries(page, range, 'steps');
  if (steps.some((value) => typeof object(value).type !== 'string')) throw historyPageIncomplete();
  return steps;
}

function turnStarts(value: unknown, total: number): number[] {
  const starts: number[] = [];
  for (const item of list(object(value).turns)) {
    const start = object(item).startStepIndex ?? 0;
    if (!index(start) || start >= total || start <= (starts.at(-1) ?? -1)) return [];
    starts.push(start);
  }
  return starts;
}

async function readSnapshot(backend: ManagementBackend, scope: Scope): Promise<NativeSnapshot> {
  const result = await requestWindow(backend, scope, {
    ...EMPTY_WINDOW,
    compact: true,
    generators: { ...EMPTY_WINDOW, end: 1 },
  });
  windowSteps(result.steps, EMPTY_WINDOW);
  const total = result.steps.totalLength ?? 0;
  if (!index(total)) throw historyPageIncomplete();
  const generators = object(result.trajectory.generatorMetadatasUpdate).totalLength;
  return {
    trajectoryId: result.trajectoryId,
    total,
    turns: turnStarts(result.update.turnsUpdate, total),
    generators: index(generators) ? generators : 0,
    status: result.update.status,
  };
}

function firstIndex(turns: number[], end: number) {
  const minimum = Math.max(0, end - PAGE_STEPS);
  const previous = turns.filter((value) => value >= minimum && value < end);
  if (minimum === 0 && previous.length <= PAGE_TURNS) return 0;
  return previous.at(-Math.min(previous.length, PAGE_TURNS)) ?? minimum;
}

async function trySteps(backend: ManagementBackend, scope: Scope, snapshot: NativeSnapshot, input: HistoryPageRequest) {
  try {
    const page = await requestWindow(backend, scope, input);
    const total = page.steps.totalLength;
    if (!index(total)) throw historyPageIncomplete();
    if (page.trajectoryId !== snapshot.trajectoryId || total < snapshot.total) throw changed();
    if (total > snapshot.total) throw historyPageIncomplete();
    return windowSteps(page.steps, input);
  } catch (error) {
    if (!(error instanceof NativeHistoryPageTooLarge)) throw error;
    return undefined;
  }
}

async function readBoundedSteps(backend: ManagementBackend, scope: Scope, snapshot: NativeSnapshot, range: Range) {
  let { start } = range;
  const { end } = range;
  // 正常路径不精简；先缩原生详情，再依次缩短请求。单步仍过大时保留明确占位，而不是阻断后续翻页。
  for (;;) {
    const full = await trySteps(backend, scope, snapshot, { start, end });
    if (full) return { start, steps: full, compact: false };
    const compact = await trySteps(backend, scope, snapshot, { start, end, compact: true });
    if (compact) return { start, steps: compact, compact: true };
    if (start + 1 === end) return { start, steps: [{ type: OMITTED_HISTORY_STEP }], compact: false };
    const midpoint = start + Math.floor((end - start) / 2);
    start = snapshot.turns.find((turn) => turn >= midpoint && turn < end) ?? midpoint;
  }
}

function requireIdle(snapshot: NativeSnapshot) {
  if (snapshot.total > 0 && snapshot.status !== 'CASCADE_RUN_STATUS_IDLE')
    throw new SessionError(409, 'session_busy', 'Antigravity 会话尚未空闲，请结束后重试。');
}
function resolveEnd(scope: Scope, snapshot: NativeSnapshot, before?: string) {
  if (!before) {
    requireIdle(snapshot);
    return { end: snapshot.total, turnBoundary: true };
  }
  const cursor = decodeCursor(before);
  if (cursor.id !== scope.id || cursor.trajectoryId !== snapshot.trajectoryId || snapshot.total < cursor.total)
    throw changed();
  return {
    end: cursor.before,
    turnBoundary: snapshot.turns.includes(cursor.before) ? true : cursor.turnBoundary ? undefined : false,
  };
}

function generatorOffsets(id: string, snapshot: NativeSnapshot, steps: unknown[], start: number) {
  return steps.flatMap((step, offset) => {
    if (object(step).type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') return [];
    const source = object(object(object(step).metadata).sourceTrajectoryStepInfo);
    const metadataIndex = source.metadataIndex === undefined ? 0 : source.metadataIndex;
    return index(metadataIndex) &&
      source.cascadeId === id &&
      source.trajectoryId === snapshot.trajectoryId &&
      metadataIndex < snapshot.generators &&
      source.stepIndex === start + offset
      ? [metadataIndex]
      : [];
  });
}

/** 较早页只精确读取对应生成记录，不能用从偏移读到尾的接口。超限则保留步骤自带的统计。 */
async function olderMetrics(backend: ManagementBackend, scope: Scope, snapshot: NativeSnapshot, offsets: number[]) {
  if (!offsets.length) return {};
  const end = Math.max(...offsets) + 1;
  const start = Math.max(Math.min(...offsets), end - PAGE_STEPS);
  const range = { start, end };
  try {
    const page = await requestWindow(backend, scope, {
      ...EMPTY_WINDOW,
      generators: range,
      limit: GENERATORS_PAGE_BYTES,
    });
    const generators = object(page.trajectory.generatorMetadatasUpdate);
    if (page.trajectoryId !== snapshot.trajectoryId || generators.totalLength !== snapshot.generators) return {};
    return {
      generatorMetadata: windowEntries(generators, range, 'generatorMetadatas'),
      generatorMetadataOffset: start,
    };
  } catch {
    return {};
  }
}

/** 不请求生成消息正文；仅在索引和长度能核对时用于最新上下文及对应时序。 */
async function latestMetrics(backend: ManagementBackend, id: string, snapshot: NativeSnapshot, offsets: number[]) {
  if (!snapshot.generators) return {};
  const last = snapshot.generators - 1;
  const near = Math.min(last, ...offsets.filter((offset) => offset >= snapshot.generators - PAGE_STEPS));
  const read = async (offset: number) => {
    try {
      const data = await backend.request(
        'GetCascadeTrajectoryGeneratorMetadata',
        {
          cascadeId: id,
          generatorMetadataOffset: offset,
          includeMessages: false,
        },
        'page',
      );
      const generatorMetadata = list(data.generatorMetadata);
      return generatorMetadata.length === snapshot.generators - offset
        ? { generatorMetadata, generatorMetadataOffset: offset }
        : undefined;
    } catch {
      return undefined;
    }
  };
  return (await read(near)) ?? (near < last ? await read(last) : undefined) ?? {};
}

export async function readAntigravityHistoryWindow(
  backend: ManagementBackend,
  scope: Scope,
  before?: string,
): Promise<HistoryWindow> {
  const snapshot = await readSnapshot(backend, scope);
  const ending = resolveEnd(scope, snapshot, before);
  const { end } = ending;
  const bounded = end
    ? await readBoundedSteps(backend, scope, snapshot, { start: firstIndex(snapshot.turns, end), end })
    : { start: 0, steps: [], compact: false };
  const { start, steps, compact } = keepRecentTurns(bounded);
  const startsTurn = snapshot.turns.includes(start) || isUserStep(steps[0]);
  const cursor = () =>
    Buffer.from(JSON.stringify([scope.id, snapshot.trajectoryId, start, snapshot.total, startsTurn])).toString(
      'base64url',
    );
  const offsets = generatorOffsets(scope.id, snapshot, steps, start);
  const metrics = before
    ? await olderMetrics(backend, scope, snapshot, offsets)
    : end
      ? await latestMetrics(backend, scope.id, snapshot, offsets)
      : {};
  const partialEnd = !(ending.turnBoundary ?? (await verifyTurnBoundary(backend, scope, snapshot, end)));
  return {
    trajectory: { cascadeId: scope.id, trajectoryId: snapshot.trajectoryId, steps, ...metrics },
    page: { start, ...(start ? { before: cursor() } : {}) },
    partialStart: start !== 0 && !startsTurn,
    partialEnd,
    compact,
  };
}

function isUserStep(step: unknown) {
  return object(step).type === 'CORTEX_STEP_TYPE_USER_INPUT';
}

/** 原生轮次目录缺失或不全时，用实际返回的用户步骤再次核对页上限。 */
function keepRecentTurns(page: { start: number; steps: unknown[]; compact: boolean }) {
  const users = page.steps.flatMap((step, offset) => (isUserStep(step) ? [offset] : []));
  if (users.length <= PAGE_TURNS) return page;
  const trim = users.at(-PAGE_TURNS)!;
  return { ...page, start: page.start + trim, steps: page.steps.slice(trim) };
}

async function verifyTurnBoundary(backend: ManagementBackend, scope: Scope, snapshot: NativeSnapshot, end: number) {
  // 轮头未列入目录时只读相邻一步核对，不接受客户端游标自报的终态。
  try {
    const step = await trySteps(backend, scope, snapshot, { start: end, end: end + 1, compact: true });
    return isUserStep(step?.[0]);
  } catch {
    return false;
  }
}

export async function readAntigravityHistoryStep(backend: ManagementBackend, scope: Scope, step: number) {
  const range = { start: step, end: step + 1, limit: MEDIA_STEP_BYTES };
  const { steps } = await requestWindow(backend, scope, range);
  if (!index(steps.totalLength) || steps.totalLength < range.end) throw historyPageIncomplete();
  return windowSteps(steps, range)[0];
}

/** 分支只查已核实绝对位置，不能拿裁剪后的原生首包长度当会话末尾。 */
export async function readAntigravityForkStep(
  backend: ManagementBackend,
  scope: Scope,
  locate: (total: number) => number,
) {
  const snapshot = await readSnapshot(backend, scope);
  requireIdle(snapshot);
  const point = locate(snapshot.total);
  const range = { start: point, end: point + 1, compact: true };
  const page = await requestWindow(backend, scope, range);
  if (page.trajectoryId !== snapshot.trajectoryId || page.steps.totalLength !== snapshot.total) throw changed();
  requireIdle({ ...snapshot, status: page.update.status });
  return { point, step: windowSteps(page.steps, range)[0] };
}
