import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { reviewAntigravityCurrentTurn } from '../../../../src/agents/antigravity/commands/completion';

const cwd = path.join(tmpdir(), 'agentdeck-agy-current-turn');
const sessionId = 'native-resumed';
const rateLimit = 'API error (attempt 1): Error 429, Message: Upstream rate limit exceeded, please retry later';
const step = (type: string, extra: Record<string, unknown> = {}) => ({
  type: `CORTEX_STEP_TYPE_${type}`,
  status: 'CORTEX_STEP_STATUS_DONE',
  ...extra,
});

function fixture() {
  const trajectory = {
    cascadeId: sessionId,
    steps: [
      step('USER_INPUT'),
      step('ERROR_MESSAGE', { errorMessage: { error: { userErrorMessage: 'Error 524: earlier' } } }),
      step('USER_INPUT'),
      step('SYSTEM_MESSAGE'),
      step('PLANNER_RESPONSE', { plannerResponse: { response: '本轮答复。' } }),
    ],
  };
  const boundary = { sessionId, inputIndex: 2, latestIndex: 4, errorIndices: [] as number[], rateLimitedResult: false };
  const read = vi.fn(async () => ({ trajectory }));
  const review = () => reviewAntigravityCurrentTurn(read, { sessionId, cwd, boundary }, new AbortController().signal);
  return { trajectory, boundary, read, review };
}

it('只认本轮最终公开答复，不把输入前的旧错误当本轮故障', async () => {
  const f = fixture();
  const result = await f.review();
  expect(f.read).toHaveBeenCalledWith(sessionId, cwd, expect.any(AbortSignal));
  expect(result).toEqual({
    status: 'completed',
    finalIndex: 4,
    finalStep: f.trajectory.steps[4],
    verifiedCompletion: true,
  });
});

it('本轮 DONE 的 ERROR_MESSAGE 仍是当前错误且不回传原始详情', async () => {
  const f = fixture();
  f.trajectory.steps[4] = step('ERROR_MESSAGE', {
    errorMessage: { error: { shortError: 'Error 524; token=synthetic-secret; https://private.invalid/path' } },
  });
  f.boundary.errorIndices = [4];
  const result = await f.review();
  expect(result).toEqual({ status: 'error', message: expect.stringContaining('HTTP 524') });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|private\.invalid/);
});

it('没有错误详情的本轮 ERROR_MESSAGE 也不能被后续答复覆盖', async () => {
  const f = fixture();
  f.trajectory.steps[3] = step('ERROR_MESSAGE');
  f.boundary.errorIndices = [3];
  const result = await f.review();
  expect(result).toEqual({ status: 'error', message: expect.stringContaining('本轮') });
});

it('本轮原生终态错误给出固定脱敏诊断', async () => {
  const f = fixture();
  f.trajectory.steps[3] = step('PLANNER_RESPONSE', {
    status: 'CORTEX_STEP_STATUS_ERROR',
    error: { message: 'Error 524; token=synthetic-secret' },
  });
  const result = await f.review();
  expect(result).toEqual({ status: 'error', message: expect.stringContaining('HTTP 524') });
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
});

it.each(['RUN_COMMAND', 'VIEW_FILE'])('本轮 %s 工具自身失败后有答复时，不冒充模型回合失败', async (type) => {
  const f = fixture();
  f.trajectory.steps[3] = step(type, {
    status: 'CORTEX_STEP_STATUS_ERROR',
    error: { type: 'TOOL_ERROR', message: 'Error 524: synthetic tool failure' },
  });
  expect(await f.review()).toEqual({ status: 'unknown' });
});

it.each(['ERROR', 'DONE'])('工具步骤含结构化服务终态错误时保留当前524：%s', async (status) => {
  const f = fixture();
  f.trajectory.steps[3] = step('RUN_COMMAND', {
    status: `CORTEX_STEP_STATUS_${status}`,
    error: { type: 'UNKNOWN_ERROR', message: 'Error 524; token=synthetic-secret' },
  });
  const result = await f.review();
  expect(result).toEqual({ status: 'error', message: expect.stringContaining('HTTP 524') });
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
});

it('工具命令输出中的 HTTP 524 不当作结构化模型服务故障', async () => {
  const f = fixture();
  f.trajectory.steps[3] = step('RUN_COMMAND', { runCommand: { output: 'HTTP 524: synthetic tool output' } });
  expect(await f.review()).toMatchObject({ status: 'completed' });
});

it('工具结构化错误中的 HTTP 500 没有明确模型服务归属时保留未知', async () => {
  const f = fixture();
  f.trajectory.steps[3] = step('RUN_COMMAND', {
    status: 'CORTEX_STEP_STATUS_ERROR',
    error: { type: 'UNKNOWN_ERROR', message: 'HTTP 500: synthetic tool failure' },
  });
  expect(await f.review()).toEqual({ status: 'unknown' });
});

it('已结束的纯429后有完整最终答复时，只确认答复完成', async () => {
  const f = fixture();
  f.trajectory.steps[3] = step('ERROR_MESSAGE', { errorMessage: { error: { userErrorMessage: rateLimit } } });
  f.boundary.errorIndices = [3];
  f.boundary.rateLimitedResult = true;
  expect(await f.review()).toEqual({
    status: 'completed',
    finalIndex: 4,
    finalStep: f.trajectory.steps[4],
    verifiedCompletion: true,
  });
});

it.each([true, false])('同一错误的不同字段分别为429和524时优先保留当前524，结果为429：%s', async (result429) => {
  const f = fixture();
  f.trajectory.steps[3] = step('ERROR_MESSAGE', {
    errorMessage: { error: { userErrorMessage: 'Error 429', shortError: 'Error 524' } },
  });
  f.boundary.errorIndices = [3];
  f.boundary.rateLimitedResult = result429;
  expect(await f.review()).toEqual({ status: 'error', message: expect.stringContaining('HTTP 524') });
});

it('同一错误的不同字段均为已知纯429格式时仍可复核恢复', async () => {
  const f = fixture();
  f.trajectory.steps[3] = step('ERROR_MESSAGE', {
    errorMessage: { error: { userErrorMessage: 'Error 429', shortError: rateLimit } },
  });
  f.boundary.errorIndices = [3];
  f.boundary.rateLimitedResult = true;
  expect(await f.review()).toMatchObject({ status: 'completed', verifiedCompletion: true });
});

it('同一错误含无法辨别的原生包装时不自动判定429已恢复', async () => {
  const f = fixture();
  f.trajectory.steps[3] = step('ERROR_MESSAGE', {
    errorMessage: { error: { userErrorMessage: 'Error 429', shortError: 'synthetic native error wrapper' } },
  });
  f.boundary.errorIndices = [3];
  f.boundary.rateLimitedResult = true;
  const result = await f.review();
  expect(result.status).not.toBe('completed');
  expect(JSON.stringify(result)).not.toContain('synthetic native error wrapper');
});

it('最终答复完成但 result 报429且轨迹没有限流步骤时不能用作已恢复证据', async () => {
  const f = fixture();
  f.boundary.rateLimitedResult = true;
  expect(await f.review()).toEqual({
    status: 'completed',
    finalIndex: 4,
    finalStep: f.trajectory.steps[4],
    verifiedCompletion: false,
  });
});

it('纯429没有后续完整答复时保留本轮限流错误', async () => {
  const f = fixture();
  f.trajectory.steps[4] = step('ERROR_MESSAGE', { errorMessage: { error: { userErrorMessage: rateLimit } } });
  f.boundary.errorIndices = [4];
  expect(await f.review()).toEqual({ status: 'error', message: expect.stringContaining('429') });
});

it.each([
  'identity',
  'input',
  'later-input',
  'stale',
  'live-error-mismatch',
  'unfinished',
  'empty',
  'tool-exit',
] as const)('遇到 %s 时不能确认完整答复', async (scenario) => {
  const f = fixture();
  if (scenario === 'identity') f.trajectory.cascadeId = 'another-session';
  if (scenario === 'input') f.trajectory.steps[2] = step('SYSTEM_MESSAGE');
  if (scenario === 'later-input') f.trajectory.steps.push(step('USER_INPUT'));
  if (scenario === 'stale') f.boundary.latestIndex = 5;
  if (scenario === 'live-error-mismatch') f.boundary.errorIndices = [3];
  if (scenario === 'unfinished') f.trajectory.steps[3] = step('RUN_COMMAND', { status: 'CORTEX_STEP_STATUS_RUNNING' });
  if (scenario === 'empty') f.trajectory.steps[4] = step('PLANNER_RESPONSE', { plannerResponse: { response: ' ' } });
  if (scenario === 'tool-exit') f.trajectory.steps[3] = step('RUN_COMMAND', { runCommand: { exitCode: 1 } });
  expect(await f.review()).toEqual({ status: 'unknown' });
});

it('原生读取失败或取消时保留未知状态', async () => {
  const f = fixture();
  const failed = vi.fn(async () => {
    throw new Error('synthetic-private-failure');
  });
  expect(
    await reviewAntigravityCurrentTurn(failed, { sessionId, cwd, boundary: f.boundary }, new AbortController().signal),
  ).toEqual({ status: 'unknown' });
  const controller = new AbortController();
  const read = vi.fn((_id: string, _cwd: string, signal?: AbortSignal) => {
    expect(signal).toBeDefined();
    return new Promise<{ trajectory: Record<string, unknown> }>(() => {});
  });
  const pending = reviewAntigravityCurrentTurn(read, { sessionId, cwd, boundary: f.boundary }, controller.signal);
  await Promise.resolve();
  controller.abort();
  expect(await pending).toEqual({ status: 'unknown' });
});
