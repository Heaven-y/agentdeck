import { managementObject as object, managementText as text, type ManagementRecord } from './management-rpc';
import type { AntigravitySessionManagement } from './session-management-types';
import {
  ANTIGRAVITY_PERMISSION_NOTICE,
  additionalServiceDiagnostic,
  antigravityDiagnostic,
  rateLimitFailure,
  rateLimitOnlyFailure,
} from './diagnostics';

export type CompletionBoundary = {
  sessionId: string;
  inputIndex: number;
  latestIndex: number;
  errorIndices: number[];
  rateLimitedResult: boolean;
};
export type TrajectoryReader = NonNullable<AntigravitySessionManagement['readTrajectory']>;
export type CurrentTurnReview =
  | { status: 'completed'; finalIndex: number; finalStep: ManagementRecord; verifiedCompletion: boolean }
  | { status: 'error'; message: string }
  | { status: 'unknown' };
const DONE = 'CORTEX_STEP_STATUS_DONE';
const INPUT = 'CORTEX_STEP_TYPE_USER_INPUT';
const ERROR_MESSAGE = 'CORTEX_STEP_TYPE_ERROR_MESSAGE';
const TOOL_STEPS = new Set([
  'CORTEX_STEP_TYPE_RUN_COMMAND',
  'CORTEX_STEP_TYPE_VIEW_FILE',
  'CORTEX_STEP_TYPE_FILE_CHANGE',
  'CORTEX_STEP_TYPE_WRITE_TO_FILE',
  'CORTEX_STEP_TYPE_MCP_TOOL',
  'CORTEX_STEP_TYPE_GENERIC',
]);
const FAILED_STATES = new Set([
  'CORTEX_STEP_STATUS_ERROR',
  'CORTEX_STEP_STATUS_INVALID',
  'CORTEX_STEP_STATUS_CANCELED',
  'CORTEX_STEP_STATUS_CANCELLED',
  'CORTEX_STEP_STATUS_INTERRUPTED',
]);

function completedStep(step: ManagementRecord): boolean {
  if (step.status !== DONE || step.error || step.type === INPUT || step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE')
    return false;
  const command = object(step.runCommand);
  return (
    command.userRejected !== true &&
    command.timedOut !== true &&
    !(typeof command.exitCode === 'number' && command.exitCode !== 0) &&
    object(step.mcpTool).userRejected !== true &&
    object(step.checkpoint).modelSummarizationFailed !== true
  );
}

function completedTrajectory(trajectory: ManagementRecord, sessionId: string, boundary: CompletionBoundary): boolean {
  if (trajectory.cascadeId !== sessionId || !Array.isArray(trajectory.steps)) return false;
  const steps: unknown[] = trajectory.steps;
  const input = object(steps[boundary.inputIndex]);
  if (input.type !== INPUT || input.status !== DONE || steps.length - 1 < boundary.latestIndex) return false;
  if (!boundary.errorIndices.every((index) => rateLimitedStep(object(steps[index])))) return false;
  const current = steps.slice(boundary.inputIndex + 1).map(object);
  return completedRound(current, boundary.rateLimitedResult);
}

function completedRound(current: ManagementRecord[], requiresRateLimit: boolean): boolean {
  if (requiresRateLimit && !current.some(rateLimitedStep)) return false;
  if (!current.length || !current.every((step) => completedStep(step) || rateLimitedStep(step))) return false;
  return finalResponse(current.at(-1)!);
}

function finalResponse(last: ManagementRecord): boolean {
  const response = object(last.plannerResponse);
  return (
    last.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' &&
    !!(text(response.modifiedResponse) || text(response.response)).trim()
  );
}

/** 错误步骤保留在轨迹中；只有已终止的明确 429 可由同轮更后的完整答复确认恢复。 */
function rateLimitedStep(step: ManagementRecord): boolean {
  return (
    step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' &&
    step.status === DONE &&
    !step.error &&
    rateLimitOnlyFailure(text(object(object(step.errorMessage).error).userErrorMessage)) &&
    errorTexts(step).every(rateLimitOnlyFailure)
  );
}

function toolStep(step: ManagementRecord): boolean {
  return (
    TOOL_STEPS.has(text(step.type)) ||
    !!text(object(object(step.metadata).toolCall).name) ||
    object(step.error).type === 'TOOL_ERROR'
  );
}

function toolServiceFailure(step: ManagementRecord): { type: 'error'; message: string } | undefined {
  const error = object(step.error);
  const type = text(error.type);
  if (!type || type === 'TOOL_ERROR' || (step.status !== DONE && !FAILED_STATES.has(text(step.status)))) return;
  // 只识别结构化的服务诊断；工具正文和普通 HTTP 500 不代表模型服务错误。
  const diagnostic = antigravityDiagnostic(text(error.message), 'tool');
  return diagnostic?.type === 'error' ? diagnostic : undefined;
}

function definiteFailure(step: ManagementRecord): boolean {
  const command = object(step.runCommand);
  if (step.type === ERROR_MESSAGE) return !rateLimitedStep(step);
  if (
    command.userRejected === true ||
    object(step.mcpTool).userRejected === true ||
    object(step.checkpoint).modelSummarizationFailed === true
  )
    return true;
  // 工具自身失败可能已由模型处理；不能把它直接归为模型回合失败。
  if (toolStep(step)) return !!toolServiceFailure(step);
  return FAILED_STATES.has(text(step.status)) || !!step.error;
}

function errorTexts(step: ManagementRecord): string[] {
  const error = object(object(step.errorMessage).error);
  const detail = object(step.error);
  return [
    error.userErrorMessage,
    error.shortError,
    error.modelErrorMessage,
    error.fullError,
    error.message,
    detail.userErrorMessage,
    detail.shortError,
    detail.modelErrorMessage,
    detail.fullError,
    detail.message,
    step.error,
  ].filter((value): value is string => typeof value === 'string' && !!value.trim());
}

function diagnosedError(value: string): { message: string; limited: boolean } | undefined {
  const limited = rateLimitOnlyFailure(value);
  if (rateLimitFailure(value) && !limited) {
    const other = value.replace(/\b429\b/g, '');
    const diagnostic = antigravityDiagnostic(other);
    return {
      message: diagnostic?.type === 'error' ? diagnostic.message : additionalServiceDiagnostic(other).message,
      limited,
    };
  }
  const diagnostic = antigravityDiagnostic(value);
  return diagnostic?.type === 'error' ? { message: diagnostic.message, limited } : undefined;
}

function currentErrorMessage(step: ManagementRecord): string {
  if (object(step.runCommand).userRejected === true || object(step.mcpTool).userRejected === true)
    return ANTIGRAVITY_PERMISSION_NOTICE;
  const toolDiagnostic = toolStep(step) ? toolServiceFailure(step) : undefined;
  if (toolDiagnostic) return toolDiagnostic.message;
  let limited: string | undefined;
  for (const value of errorTexts(step)) {
    const diagnostic = diagnosedError(value);
    if (!diagnostic) continue;
    if (!diagnostic.limited) return diagnostic.message;
    limited = diagnostic.message;
  }
  return limited ?? 'Antigravity 原生会话记录了本轮错误，请核对原生会话。';
}

function validBoundary(boundary: CompletionBoundary, sessionId: string): boolean {
  return (
    boundary.sessionId === sessionId &&
    Number.isSafeInteger(boundary.inputIndex) &&
    boundary.inputIndex >= 0 &&
    Number.isSafeInteger(boundary.latestIndex) &&
    boundary.latestIndex >= boundary.inputIndex &&
    Array.isArray(boundary.errorIndices)
  );
}

function currentSteps(
  trajectory: ManagementRecord,
  sessionId: string,
  boundary: CompletionBoundary,
): ManagementRecord[] | undefined {
  if (trajectory.cascadeId !== sessionId || !Array.isArray(trajectory.steps) || !validBoundary(boundary, sessionId))
    return;
  const steps: unknown[] = trajectory.steps;
  const input = object(steps[boundary.inputIndex]);
  if (input.type !== INPUT || input.status !== DONE || steps.length - 1 < boundary.latestIndex) return;
  if (
    !boundary.errorIndices.every(
      (index) =>
        Number.isSafeInteger(index) &&
        index > boundary.inputIndex &&
        index <= boundary.latestIndex &&
        object(steps[index]).type === ERROR_MESSAGE,
    )
  )
    return;
  const current = steps.slice(boundary.inputIndex + 1).map(object);
  return current.some((step) => step.type === INPUT) ? undefined : current;
}

function currentTurn(trajectory: ManagementRecord, sessionId: string, boundary: CompletionBoundary): CurrentTurnReview {
  const current = currentSteps(trajectory, sessionId, boundary);
  if (!current) return { status: 'unknown' };
  const failure = current.findLast(definiteFailure);
  if (failure) return { status: 'error', message: currentErrorMessage(failure) };
  if (completedRound(current, false)) {
    const finalIndex = boundary.inputIndex + current.length;
    return {
      status: 'completed',
      finalIndex,
      finalStep: current.at(-1)!,
      verifiedCompletion: completedTrajectory(trajectory, sessionId, boundary),
    };
  }
  const limited = current.findLast(rateLimitedStep);
  return limited ? { status: 'error', message: currentErrorMessage(limited) } : { status: 'unknown' };
}

async function withTrajectory<T>({
  read,
  input,
  signal,
  inspect,
  fallback,
}: {
  read: TrajectoryReader;
  input: { sessionId: string; cwd: string };
  signal: AbortSignal;
  inspect: (trajectory: ManagementRecord) => T;
  fallback: T;
}): Promise<T> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  if (bounded.aborted) return fallback;
  let abort!: () => void;
  const cancelled = new Promise<T>((resolve) => {
    abort = () => resolve(fallback);
    bounded.addEventListener('abort', abort, { once: true });
  });
  try {
    const verified = Promise.resolve()
      .then(() => read(input.sessionId, input.cwd, bounded))
      .then(({ trajectory }) => inspect(trajectory))
      .catch(() => fallback);
    return await Promise.race([verified, cancelled]);
  } finally {
    bounded.removeEventListener('abort', abort);
  }
}

/** 仅复核当前轮事实；完成答复不等于能够判定累计 result 的归属。 */
export function reviewAntigravityCurrentTurn(
  read: TrajectoryReader,
  input: { sessionId: string; cwd: string; boundary: CompletionBoundary },
  signal: AbortSignal,
): Promise<CurrentTurnReview> {
  return withTrajectory<CurrentTurnReview>({
    read,
    input,
    signal,
    inspect: (trajectory) => currentTurn(trajectory, input.sessionId, input.boundary),
    fallback: { status: 'unknown' },
  });
}
