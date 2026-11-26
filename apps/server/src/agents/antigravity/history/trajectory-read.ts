import { SessionError } from '../../errors';
import {
  managementObject as object,
  managementByteLimit,
  type ManagementBackend,
  type ManagementBudget,
  type ManagementRecord,
} from '../management/management-rpc';

function incomplete(): never {
  throw new SessionError(503, 'session_history_incomplete', 'Antigravity 历史未完整读取，请稍后重试。');
}

function assertWithinSize(bytes: number, budget?: ManagementBudget) {
  if (bytes <= managementByteLimit(budget)) return;
  incomplete();
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function totalSteps(response: ManagementRecord, steps: unknown[]): number {
  const total = response.numTotalSteps ?? steps.length;
  if (!Number.isSafeInteger(total) || Number(total) < steps.length) incomplete();
  return Number(total);
}

function addPage(steps: unknown[], page: ManagementRecord, total: number): void {
  const next = list(page.steps);
  if (!next.length || steps.length + next.length > total) incomplete();
  steps.push(...next);
}

function completeMetadata(response: ManagementRecord, trajectory: ManagementRecord): unknown[] {
  const metadata = list(trajectory.generatorMetadata);
  // 生成元数据分页不影响正文；未取得末页时隐藏上下文，不能把旧页贴到最新会话。
  return (response.numTotalGeneratorMetadata ?? metadata.length) === metadata.length ? metadata : [];
}

/** 原生分页只有 offset，没有 page size；按已返回步骤继续补齐，核对总数并支持取消。 */
export async function completeTrajectory(
  backend: ManagementBackend,
  response: ManagementRecord,
  signal?: AbortSignal,
  budget?: ManagementBudget,
): Promise<ManagementRecord> {
  const trajectory = object(response.trajectory);
  const steps = [...list(trajectory.steps)];
  const total = totalSteps(response, steps);
  let bytes = Buffer.byteLength(JSON.stringify(response));
  const deadline = Date.now() + 30_000;
  assertWithinSize(bytes, budget);
  while (steps.length < total) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) incomplete();
    const page = await backend.request(
      'GetCascadeTrajectorySteps',
      {
        cascadeId: trajectory.cascadeId,
        stepOffset: steps.length,
        trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_FULL',
      },
      budget,
    );
    bytes += Buffer.byteLength(JSON.stringify(page));
    assertWithinSize(bytes, budget);
    addPage(steps, page, total);
  }
  signal?.throwIfAborted();
  return { ...trajectory, steps, generatorMetadata: completeMetadata(response, trajectory) };
}
