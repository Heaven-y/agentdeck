import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agentdeck/shared/conversation';
import { createAntigravityRunner, type AntigravityProcess } from '../../../../src/agents/antigravity/adapter';
import type { AntigravitySessionManagement } from '../../../../src/agents/antigravity/history/session-management-types';

const cwd = path.join(tmpdir(), 'agentdeck-agy-completion');
const previousError = 'agent executor error: generating and executing: Error 524, Status: 524 unknown';
const rateLimitError = 'API error (attempt 1): Error 429, Message: Upstream rate limit exceeded, please retry later';
afterEach(() => vi.useRealTimers());

async function resumedTurn(resume = true, readTrajectory?: AntigravitySessionManagement['readTrajectory']) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const events: AgentEvent[] = [];
  const runner = createAntigravityRunner({
    launch: () => child as unknown as AntigravityProcess,
    defaultModel: async () => undefined,
    readTrajectory,
  });
  const handle = runner({
    workspace: { id: 'p', name: '项目', dir: cwd },
    sessionId: resume ? 'native-resumed' : undefined,
    text: '继续示例',
    emit: (event) => events.push(event),
    requestPermission: async () => ({ allow: false }),
  });
  await Promise.resolve();
  const output = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
  output({ event: 'init', conversation_id: 'native-resumed', init: { cwd } });
  const step = (index: number, type: string, state = 'DONE', extra?: Record<string, unknown>) =>
    output({
      event: 'step_update',
      step_update: {
        conversation_id: 'native-resumed',
        step_index: index,
        step_type: type,
        state,
        ...extra,
      },
    });
  const result = (changes: Record<string, unknown> = {}) =>
    output({
      event: 'result',
      result: {
        conversation_id: 'native-resumed',
        status: 'ERROR',
        error: previousError,
        response: '本轮完成。\n',
        num_turns: 2,
        ...changes,
      },
    });
  return { child, events, handle, step, result, runner };
}

function expectUnconfirmed(events: AgentEvent[], completedReplyStepId?: string) {
  expect(events.filter((event) => event.type === 'error')).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    type: 'turn_end',
    isError: true,
    outcome: 'unconfirmed',
    ...(completedReplyStepId ? { completedReplyStepId } : {}),
  });
  if (!completedReplyStepId) expect(events.at(-1)).not.toHaveProperty('completedReplyStepId');
}

function expectNativeFailure(events: AgentEvent[], diagnostic?: string) {
  expect(events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  const errors = events.filter((event) => event.type === 'error');
  expect(errors).toHaveLength(1);
  if (diagnostic) expect(errors[0]!.message).toContain(diagnostic);
}

it('累计 result 与历史错误一致时，完成答复后仍保留无法确定本轮归属的状态', async () => {
  const trajectory = completedTrajectory();
  trajectory.steps.splice(
    5,
    2,
    { ...trajectory.steps[5]!, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' },
    { ...trajectory.steps[5]!, type: 'CORTEX_STEP_TYPE_RUN_COMMAND' },
    { ...trajectory.steps[6]! },
  );
  const read = vi.fn(async () => ({ trajectory }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(5, 'agent_response', 'DONE', { text_delta: '准备执行。' });
  f.step(6, 'tool');
  f.step(7, 'agent_response', 'ACTIVE', { text_delta: '本轮完成。' });
  // 工具的迟到更新不能覆盖更高索引的最终公开答复。
  f.step(6, 'tool');
  f.step(7, 'agent_response', 'DONE', { text_delta: '\n' });
  f.result();
  expect(f.events.some((event) => event.type === 'error' || event.type === 'turn_end')).toBe(false);
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).toHaveBeenCalledOnce();
  expectUnconfirmed(f.events, 'agy-step-7');
});

function completedTrajectory() {
  const step = (type: string, extra?: Record<string, unknown>) => ({
    type: `CORTEX_STEP_TYPE_${type}`,
    status: 'CORTEX_STEP_STATUS_DONE',
    ...extra,
  });
  return {
    cascadeId: 'native-resumed',
    steps: [
      step('USER_INPUT'),
      step('PLANNER_RESPONSE'),
      step('RUN_COMMAND'),
      step('ERROR_MESSAGE', { errorMessage: { error: { modelErrorMessage: previousError } } }),
      step('USER_INPUT'),
      step('VIEW_FILE'),
      step('PLANNER_RESPONSE', { plannerResponse: { response: '本轮已完成。' } }),
    ],
  };
}

it.each([undefined, null, '', '   '])('续接的 ERROR 缺少错误正文时不能只凭完整答复改判成功：%s', async (error) => {
  const trajectory = completedTrajectory();
  const read = vi.fn(async () => ({ trajectory }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response');
  f.result({ error });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).toHaveBeenCalledWith('native-resumed', cwd, expect.any(AbortSignal));
  expect(f.events).toContainEqual({ type: 'error', message: expect.stringContaining('未能完成本轮') });
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it.each(['same', 'different', 'none', 'tool-error', 'tool-output'] as const)(
  '续接结果与历史关系为 %s 时，仅核实旧错误与完整本轮冲突才保留未知',
  async (scenario) => {
    const error = `${previousError}; token=synthetic-secret`;
    const trajectory = completedTrajectory();
    if (scenario === 'same') Object.assign(trajectory.steps[3]!, { errorMessage: { error: { shortError: error } } });
    if (scenario === 'different')
      Object.assign(trajectory.steps[3]!, { errorMessage: { error: { shortError: 'Error 500: 不同错误' } } });
    if (scenario === 'none')
      trajectory.steps[3] = { type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE' };
    if (scenario === 'tool-error' || scenario === 'tool-output')
      trajectory.steps[3] = {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_DONE',
        ...(scenario === 'tool-error'
          ? { error: { type: 'TOOL_ERROR', message: error } }
          : { runCommand: { output: error } }),
      };
    const read = vi.fn(async () => ({ trajectory }));
    const f = await resumedTurn(true, read);
    f.step(4, 'user_input');
    f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。' });
    f.result({ error });
    f.child.emit('close', 0);
    await f.handle.done;
    expect(read).toHaveBeenCalledOnce();
    if (scenario === 'same') expectUnconfirmed(f.events, 'agy-step-6');
    else {
      expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
      expect(f.events.filter((event) => event.type === 'error')).toEqual([
        { type: 'error', message: expect.stringContaining('524') },
      ]);
    }
    expect(JSON.stringify(f.events)).not.toContain('synthetic-secret');
  },
);

it('缺少原生复核时，完成直播不能单独将 result ERROR 判成功', async () => {
  const f = await resumedTurn();
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。' });
  f.result();
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  expect(f.events).toContainEqual({ type: 'error', message: expect.stringContaining('524') });
});

it('新建会话没有历史累计结果，原生524仍显示具体诊断', async () => {
  const f = await resumedTurn(false);
  f.step(0, 'user_input');
  f.step(1, 'agent_response', 'DONE', { text_delta: '已输出的片段。' });
  f.result({ num_turns: 1 });
  f.child.emit('close', 3);
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining('模型服务响应超时') },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it.each(['step', 'stderr'] as const)('本轮 %s 缺少细节时仍展示 result 的具体脱敏诊断', async (source) => {
  const f = await resumedTurn();
  f.step(4, 'user_input');
  if (source === 'step') f.step(5, 'error_message');
  else f.child.stderr.write('error: synthetic-native-failure\n');
  f.result({ error: `${previousError}; token=synthetic-secret` });
  f.child.emit('close', 3);
  await f.handle.done;
  expectNativeFailure(f.events, '524');
  expect(JSON.stringify(f.events)).not.toMatch(/synthetic-native-failure|synthetic-secret/);
});

it('续接纯429的原生复核读取失败时保留本轮失败', async () => {
  const read = vi.fn(async () => {
    throw new Error('synthetic-private-failure');
  });
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '已输出的片段。' });
  f.result({ error: rateLimitError });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).toHaveBeenCalledOnce();
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  expect(f.events).toContainEqual({ type: 'error', message: expect.stringContaining('429') });
  expect(JSON.stringify(f.events)).not.toContain('synthetic-private-failure');
});

it.each([
  ['ERROR 未知错误', 'ERROR', { type: 'UNKNOWN_ERROR', message: '示例失败' }],
  ['ERROR 无载荷', 'ERROR', undefined],
  ['DONE 未知错误', 'DONE', { type: 'UNKNOWN_ERROR', message: '示例失败' }],
])('直播已确认终态失败 %s 时不能用不一致的轨迹改判成功', async (_case, state, error) => {
  const read = vi.fn(async () => ({ trajectory: completedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(5, 'tool', state, { tool_info: { name: 'view_file', ...(error ? { error } : {}) } });
  f.step(6, 'agent_response', 'DONE', { text_delta: '已生成的片段。' });
  f.result({ error: '' });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'tool_result', isError: true }));
  expect(read).toHaveBeenCalledOnce();
  expect(f.events.some((event) => event.type === 'error')).toBe(true);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it('续接 result 中的认证错误无独立本轮证据时保留未确认状态', async () => {
  const trajectory = completedTrajectory();
  Object.assign(trajectory.steps[3]!, {
    errorMessage: { shouldShowUser: true, error: { userErrorMessage: 'Error 401: invalid API key' } },
  });
  const read = vi.fn(async () => ({ trajectory }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response');
  f.result({ error: 'Error 401: invalid API key' });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).toHaveBeenCalledOnce();
  expectUnconfirmed(f.events, 'agy-step-6');
});

type MissingErrorGuard = {
  resume?: boolean;
  input?: number;
  result?: Record<string, unknown>;
  exit?: number;
  interrupt?: boolean;
  review?: boolean;
};
const missingErrorGuards: [string, MissingErrorGuard][] = [
  ['新建会话', { resume: false, input: 0 }],
  ['未知结果状态', { result: { status: 'UNKNOWN' } }],
  ['错误正文格式异常', { result: { error: {} }, review: true }],
  ['缺少结果身份', { result: { conversation_id: undefined } }],
  ['权限拒绝', { result: { denied_actions: [{ action: 'command' }] } }],
  ['非零退出', { exit: 3, review: true }],
  ['中断', { interrupt: true }],
];
it.each(missingErrorGuards)('无错误正文遇到%s时按可用证据分类', async (_scenario, options) => {
  const read = vi.fn(async () => ({ trajectory: completedTrajectory() }));
  const f = await resumedTurn(options.resume ?? true, read);
  const input = options.input ?? 4;
  f.step(input, 'user_input');
  f.step(input + 2, 'agent_response');
  f.result({ error: '', ...options.result });
  const interrupted = options.interrupt ? f.handle.interrupt() : undefined;
  f.child.emit('close', options.exit ?? 0);
  await interrupted;
  await f.handle.done;
  expect(read).toHaveBeenCalledTimes(options.review ? 1 : 0);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  expect(f.events.some((event) => event.type === 'error')).toBe(!options.interrupt);
});

it.each(['wrong-session', 'wrong-input', 'current-error', 'later-input', 'later-error'])(
  '无错误正文但原生复核遇到%s时仍保留失败',
  async (scenario) => {
    const trajectory = completedTrajectory();
    if (scenario === 'wrong-session') trajectory.cascadeId = 'other-session';
    if (scenario === 'wrong-input') trajectory.steps[4]!.type = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';
    if (scenario === 'current-error') trajectory.steps[5]!.type = 'CORTEX_STEP_TYPE_ERROR_MESSAGE';
    if (scenario === 'later-input') trajectory.steps.splice(6, 0, { ...trajectory.steps[4]! });
    if (scenario === 'later-error')
      trajectory.steps.push({ type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE' });
    const read = vi.fn(async () => ({ trajectory }));
    const f = await resumedTurn(true, read);
    f.step(4, 'user_input');
    if (scenario === 'current-error') f.step(5, 'error_message');
    f.step(6, 'agent_response');
    f.result({ error: '' });
    f.child.emit('close', 0);
    await f.handle.done;
    expect(read).toHaveBeenCalledOnce();
    expectNativeFailure(f.events);
  },
);

it('无错误正文但本轮 stderr 明确认证失败时保留真实诊断', async () => {
  const read = vi.fn(async () => ({ trajectory: completedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response');
  f.child.stderr.write('error: invalid API key\n');
  f.result({ error: '' });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).not.toHaveBeenCalled();
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining('认证') },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

function rateLimitedTrajectory(resume = true): Record<string, unknown> {
  const trajectory = completedTrajectory();
  Object.assign(trajectory.steps[5]!, {
    type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
    errorMessage: { shouldShowUser: true, error: { userErrorMessage: rateLimitError } },
  });
  return { ...trajectory, steps: resume ? trajectory.steps : trajectory.steps.slice(4) };
}

it.each([
  ['524', '', false],
  ['524', previousError, true],
  ['429', '', true],
  ['429', previousError, false],
])('待确认服务故障 %s 不可被无错误轨迹吞掉：%s / 结果先到=%s', async (code, error, resultFirst) => {
  const read = vi.fn(async () => ({ trajectory: completedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '已输出的片段。' });
  if (resultFirst) f.result({ error });
  f.child.stderr.write(`error: Error ${code}\n`);
  if (!resultFirst) f.result({ error });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining(code) },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it('stderr 的 429 有本轮原生 429 步骤及后续完成答复时才能复核恢复', async () => {
  const read = vi.fn(async () => ({ trajectory: rateLimitedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '原生重试后完成。' });
  f.child.stderr.write(`error: ${rateLimitError}\n`);
  f.result({ error: '' });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).toHaveBeenCalledOnce();
  expect(f.events.filter((event) => event.type === 'error')).toEqual([]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: false });
});

it('认证错误与 429 同行时不能把认证失败当作可恢复限流', async () => {
  const read = vi.fn(async () => ({ trajectory: rateLimitedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '已输出的片段。' });
  f.child.stderr.write('error: invalid API key; error: Error 429\n');
  f.result({ error: '' });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).not.toHaveBeenCalled();
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining('认证') },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it.each(['524', '500'])('同轮出现 429 和 %s 时不能以 429 轨迹覆盖服务故障', async (code) => {
  const read = vi.fn(async () => ({ trajectory: rateLimitedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '已输出的片段。' });
  f.child.stderr.write(`error: ${rateLimitError}\n`);
  f.child.stderr.write(`error: Error ${code}\n`);
  f.result({ error: '' });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).not.toHaveBeenCalled();
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining(code) },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

const mixed429Cases = [
  ['401', 'HTTP 401', '401'],
  ['502', 'HTTP 502', '502'],
  ['504', 'HTTP 504', '504'],
  ['524', 'HTTP 524', '524'],
  ['权限拒绝', 'permission denied', undefined],
  ['独立错误', 'Error: disk read failed', undefined],
  ['未知附文', 'unexpected network reset', undefined],
] as const;

it.each(mixed429Cases)('仅 result 同时含429与%s且无相同历史故障时保留本轮失败', async (_label, other, code) => {
  const read = vi.fn(async () => ({ trajectory: rateLimitedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(5, 'error_message');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。' });
  f.result({ error: `Error 429; ${other}` });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).toHaveBeenCalledOnce();
  expectNativeFailure(f.events, code ?? '其他错误');
});

it.each(mixed429Cases)('轨迹错误同时含429与%s不能作为纯429恢复', async (_label, other, code) => {
  const trajectory = rateLimitedTrajectory();
  (trajectory.steps as Record<string, unknown>[])[5]!.errorMessage = {
    error: { userErrorMessage: `${rateLimitError}; ${other}` },
  };
  const read = vi.fn(async () => ({ trajectory }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(5, 'error_message');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。' });
  f.result({ error: rateLimitError });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).toHaveBeenCalledOnce();
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining(code ?? '其他错误') },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it.each(mixed429Cases)('stderr 同时含429与%s不能作为纯429恢复', async (_label, other, code) => {
  const read = vi.fn(async () => ({ trajectory: rateLimitedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。' });
  f.child.stderr.write(`error: Error 429; ${other}\n`);
  f.result({ error: '' });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).not.toHaveBeenCalled();
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining(code ?? '其他错误') },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it.each([`error: ${rateLimitError}`, `AGY_ERROR: ${JSON.stringify({ short_error: rateLimitError })}`])(
  '原生429错误的已知外层包装仍可按同轮轨迹复核恢复',
  async (stderr) => {
    const read = vi.fn(async () => ({ trajectory: rateLimitedTrajectory() }));
    const f = await resumedTurn(true, read);
    f.step(4, 'user_input');
    f.step(6, 'agent_response', 'DONE', { text_delta: '原生重试后完成。' });
    f.child.stderr.write(`${stderr}\n`);
    f.result({ error: '' });
    f.child.emit('close', 0);
    await f.handle.done;
    expect(read).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event.type === 'error')).toEqual([]);
    expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: false });
  },
);

it.each([true, false])('原生 429 重试后的完整本轮轨迹可纠正累计 ERROR，续接：%s', async (resume) => {
  const f = await resumedTurn(resume, async () => ({ trajectory: rateLimitedTrajectory(resume) }));
  const input = resume ? 4 : 0;
  f.step(input, 'user_input');
  // 流协议不提供可依赖的错误详情，必须查原生轨迹确认错误种类。
  f.step(input + 1, 'error_message');
  f.step(input + 2, 'agent_response', 'DONE', { text_delta: '原生重试后完成。' });
  f.child.stderr.write(`error: ${rateLimitError}\n`);
  f.result({ error: rateLimitError, num_turns: resume ? 2 : 1 });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'error')).toEqual([]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: false });
});

it.each([false, true])('result 报429但本轮轨迹没有限流恢复证据时保留失败，续接：%s', async (resume) => {
  const trajectory = completedTrajectory();
  // 续接时历史轮次的 429 也不能作为本轮恢复证据。
  Object.assign(trajectory.steps[3]!, {
    errorMessage: { error: { userErrorMessage: rateLimitError } },
  });
  if (!resume) trajectory.steps = trajectory.steps.slice(4);
  const f = await resumedTurn(resume, async () => ({ trajectory }));
  const input = resume ? 4 : 0;
  f.step(input, 'user_input');
  f.step(input + 2, 'agent_response', 'DONE', { text_delta: '已经输出的答复。' });
  f.result({ error: rateLimitError, num_turns: resume ? 2 : 1 });
  f.child.emit('close', 0);
  await f.handle.done;
  if (resume) expectUnconfirmed(f.events, 'agy-step-6');
  else {
    expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
    expect(f.events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: expect.stringContaining('429') },
    ]);
  }
});

it('本轮429虽已恢复，累计 result 仍写同文524时不猜测其归属', async () => {
  const f = await resumedTurn(true, async () => ({ trajectory: rateLimitedTrajectory() }));
  f.step(4, 'user_input');
  f.step(5, 'error_message');
  f.step(6, 'agent_response', 'DONE', { text_delta: '原生重试后完成。' });
  f.result();
  f.child.emit('close', 0);
  await f.handle.done;
  expectUnconfirmed(f.events, 'agy-step-6');
});

it.each([rateLimitError, previousError])('累计结果遇到跨字段429和524时保留本轮524', async (resultError) => {
  const trajectory = rateLimitedTrajectory();
  (trajectory.steps as Record<string, unknown>[])[5]!.errorMessage = {
    error: { userErrorMessage: 'Error 429', shortError: 'Error 524' },
  };
  const f = await resumedTurn(true, async () => ({ trajectory }));
  f.step(4, 'user_input');
  f.step(5, 'error_message');
  f.step(6, 'agent_response', 'DONE', { text_delta: '已输出的答复。' });
  f.result({ error: resultError });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining('HTTP 524') },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it('直播遗漏工具终态的结构化服务错误时，轨迹复核仍保留本轮524', async () => {
  const trajectory = completedTrajectory();
  Object.assign(trajectory.steps[5]!, {
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status: 'CORTEX_STEP_STATUS_ERROR',
    error: { type: 'UNKNOWN_ERROR', message: 'Error 524; token=synthetic-secret' },
  });
  const f = await resumedTurn(true, async () => ({ trajectory }));
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '已输出的答复。' });
  f.result();
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining('HTTP 524') },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  expect(JSON.stringify(f.events)).not.toContain('synthetic-secret');
});

it.each([
  'unknown-error',
  'later-error',
  'unfinished',
  'later-input',
  'wrong-session',
  'denied',
  'exit',
  'missing-reader',
])('429 遇到%s时不能仅凭已输出文本改判成功', async (scenario) => {
  const trajectory = rateLimitedTrajectory();
  const steps = trajectory.steps as Record<string, unknown>[];
  if (scenario === 'unknown-error') steps[5]!.errorMessage = { error: { userErrorMessage: '原生不可恢复错误' } };
  if (scenario === 'later-error') steps.push({ ...steps[5] });
  if (scenario === 'unfinished') steps[6]!.status = 'CORTEX_STEP_STATUS_RUNNING';
  if (scenario === 'later-input') steps.splice(6, 0, { ...steps[4] });
  if (scenario === 'wrong-session') trajectory.cascadeId = 'other';
  if (scenario === 'denied')
    steps.splice(6, 0, {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_DONE',
      runCommand: { userRejected: true },
    });
  const f = await resumedTurn(true, scenario === 'missing-reader' ? undefined : async () => ({ trajectory }));
  f.step(4, 'user_input');
  // 即使直播遗漏错误步骤，也必须核实轨迹，不能沿用旧错误的文本启发式。
  f.step(6, 'agent_response', 'DONE', { text_delta: '一部分回答。' });
  f.result({ error: rateLimitError });
  f.child.emit('close', scenario === 'exit' ? 1 : 0);
  await f.handle.done;
  expectNativeFailure(f.events);
});

it('429 后用户中断不能被较晚到达的成功轨迹覆盖', async () => {
  let resolve!: (value: { trajectory: Record<string, unknown> }) => void;
  const pending = new Promise<{ trajectory: Record<string, unknown> }>((done) => (resolve = done));
  const read = vi.fn(() => pending);
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(5, 'error_message');
  f.step(6, 'agent_response', 'DONE', { text_delta: '已生成文本。' });
  f.result({ error: rateLimitError });
  f.child.emit('close', 0);
  await Promise.resolve();
  expect(read).toHaveBeenCalledWith('native-resumed', cwd, expect.any(AbortSignal));
  await f.handle.interrupt();
  resolve({ trajectory: rateLimitedTrajectory() });
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'turn_end')).toEqual([{ type: 'turn_end', isError: true }]);
});

it('续接退出码 3 时优先展示轨迹确认的本轮错误，而非累计结果中的旧错误', async () => {
  const trajectory = completedTrajectory();
  Object.assign(trajectory.steps[5]!, {
    type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
    errorMessage: { error: { userErrorMessage: 'Error 500: synthetic current failure; token=synthetic-secret' } },
  });
  trajectory.steps.splice(6);
  const read = vi.fn(async () => ({ trajectory }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(5, 'error_message');
  f.result({ response: '' });
  f.child.emit('close', 3);
  await f.handle.done;
  expect(read).toHaveBeenCalledOnce();
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining('HTTP 500') },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  expect(JSON.stringify(f.events)).not.toMatch(/524|synthetic-secret/);
});

it.each([true, false])('累计结果的旧答复不回放，仅轨迹复核可补齐当前答复：%s', async (hasReader) => {
  const read = vi.fn(async () => ({ trajectory: completedTrajectory() }));
  const f = await resumedTurn(true, hasReader ? read : undefined);
  f.step(4, 'user_input');
  f.result({ response: '历史答复，不属于本轮。' });
  expect(f.events.filter((event) => event.type === 'text')).toEqual([]);
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).toHaveBeenCalledTimes(hasReader ? 1 : 0);
  expect(f.events.filter((event) => event.type === 'text')).toEqual(
    hasReader ? [{ type: 'text', id: 'agy-step-6', delta: '本轮已完成。' }] : [],
  );
  if (hasReader) expectUnconfirmed(f.events, 'agy-step-6');
  else expectNativeFailure(f.events, '524');
});

it.each([
  ['累计错误', previousError, '本轮'],
  ['缺少错误详情', '', '本轮'],
  ['文本不一致', previousError, '直播中的不同文本。'],
])('%s 时已有直播正文不再追加原生文本', async (_label, error, streamed) => {
  const f = await resumedTurn(true, async () => ({ trajectory: completedTrajectory() }));
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: streamed });
  f.result({ error });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'text')).toEqual([
    { type: 'text', id: 'agy-step-6', delta: streamed },
  ]);
  if (error) expectUnconfirmed(f.events, 'agy-step-6');
  else expectNativeFailure(f.events);
});

it('直播答复之后仍有运行中的工具时不授予最终步骤或补发统计', async () => {
  const trajectory = completedTrajectory();
  Object.assign(trajectory.steps[6]!, { metadata: { modelUsage: { outputTokens: 17 } } });
  trajectory.steps.push({ type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_RUNNING' });
  const f = await resumedTurn(true, async () => ({ trajectory }));
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮已完成。' });
  f.step(7, 'tool', 'ACTIVE', { tool_name: 'run_command' });
  f.result();
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'step_usage')).toEqual([]);
  expectNativeFailure(f.events, '524');
});

it('直播已有用量但无耗时时，从已复核的同一步补齐耗时而不使用累计结果', async () => {
  const trajectory = completedTrajectory();
  Object.assign(trajectory.steps[6]!, {
    metadata: {
      createdAt: '2026-03-01T04:00:00Z',
      finishedGeneratingAt: '2026-03-01T04:00:05.500Z',
      modelUsage: { outputTokens: 999 },
    },
  });
  const f = await resumedTurn(true, async () => ({ trajectory }));
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。', usage: { output_tokens: 17 } });
  const liveStatistics = {
    type: 'step_usage',
    id: 'agy-step-6',
    usage: { outputTokens: 17, source: 'antigravity', scope: 'step' },
  };
  expect(f.events.filter((event) => event.type === 'step_usage')).toEqual([liveStatistics]);
  f.result({ duration_seconds: 999, usage: { output_tokens: 9999 } });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'step_usage')).toEqual([
    liveStatistics,
    { ...liveStatistics, durationMs: 5500 },
  ]);
  expectUnconfirmed(f.events, 'agy-step-6');
  expect(f.events.at(-1)).not.toHaveProperty('usage');
  expect(f.events.at(-1)).not.toHaveProperty('durationMs');
});

it.each(['部分用量', '无用量', '数值冲突'] as const)(
  '直播有耗时但缺少输出用量时，仅从无冲突的已复核同一步补齐：%s',
  async (scenario) => {
    const trajectory = completedTrajectory();
    Object.assign(trajectory.steps[6]!, {
      metadata: { modelUsage: { inputTokens: scenario === '数值冲突' ? 21 : 20, outputTokens: 17 } },
    });
    const f = await resumedTurn(true, async () => ({ trajectory }));
    f.step(4, 'user_input');
    f.step(6, 'agent_response', 'DONE', {
      text_delta: '本轮已完成。',
      duration_seconds: 2,
      ...(scenario === '无用量' ? {} : { usage: { input_tokens: 20 } }),
    });
    f.result();
    f.child.emit('close', 0);
    await f.handle.done;
    const usage = { inputTokens: 20, source: 'antigravity', scope: 'step' };
    const live = { type: 'step_usage', id: 'agy-step-6', durationMs: 2000, timingSource: 'native', usage };
    const merged = { ...live, usage: { ...usage, outputTokens: 17 } };
    expect(f.events.filter((event) => event.type === 'step_usage')).toEqual(
      scenario === '部分用量' ? [live, merged] : scenario === '无用量' ? [merged] : [live],
    );
    expectUnconfirmed(f.events, 'agy-step-6');
  },
);

it.each(['current-error', 'wrong-session', 'wrong-input', 'later-input', 'stale-final', 'denied', 'read-failed'])(
  '空正文结果复核遇到%s时仍保留失败，不能用另一个成功回合覆盖',
  async (scenario) => {
    const trajectory = completedTrajectory();
    if (scenario === 'current-error') trajectory.steps[5]!.type = 'CORTEX_STEP_TYPE_ERROR_MESSAGE';
    if (scenario === 'wrong-session') trajectory.cascadeId = 'other-session';
    if (scenario === 'wrong-input') trajectory.steps[4]!.type = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';
    if (scenario === 'later-input') trajectory.steps[5]!.type = 'CORTEX_STEP_TYPE_USER_INPUT';
    if (scenario === 'stale-final') trajectory.steps.splice(5);
    if (scenario === 'denied') Object.assign(trajectory.steps[5]!, { runCommand: { userRejected: true } });
    const read = vi.fn(async () => {
      if (scenario === 'read-failed') throw new Error('private-native-failure');
      return { trajectory };
    });
    const f = await resumedTurn(true, read);
    f.step(4, 'user_input');
    f.step(6, 'agent_response');
    f.result({ error: '' });
    f.child.emit('close', 0);
    await f.handle.done;
    expect(read).toHaveBeenCalledOnce();
    expectNativeFailure(f.events);
    expect(JSON.stringify(f.events)).not.toContain('private-native-failure');
  },
);

it('直播中的工具过渡错误不能把累计结果伪装为成功', async () => {
  const f = await resumedTurn(true, async () => ({ trajectory: completedTrajectory() }));
  f.step(4, 'user_input');
  f.step(5, 'tool', 'ACTIVE', { tool_info: { error: { type: 'TOOL_ERROR', message: '示例过渡状态' } } });
  f.step(5, 'tool', 'DONE');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮已完成。' });
  f.result();
  f.child.emit('close', 0);
  await f.handle.done;
  expectUnconfirmed(f.events, 'agy-step-6');
});

it.each(['interrupt', 'dispose'] as const)('进程退出后%s仍能取消终态复核并释放占用', async (action) => {
  let reviewSignal: AbortSignal | undefined;
  const read = vi.fn((_id: string, _dir: string, signal?: AbortSignal) => {
    reviewSignal = signal;
    return new Promise<{ trajectory: Record<string, unknown> }>(() => {});
  });
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response');
  f.result({ error: '' });
  f.child.emit('close', 0);
  await Promise.resolve();
  if (action === 'interrupt') await f.handle.interrupt();
  else await f.runner.dispose?.();
  await f.handle.done;
  expect(reviewSignal?.aborted).toBe(true);
  expect(f.events.filter((event) => event.type === 'turn_end')).toEqual([{ type: 'turn_end', isError: true }]);
});

it('stderr 出现 524 后原生明确返回 SUCCESS 时保留成功', async () => {
  const read = vi.fn(async () => ({ trajectory: completedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮完成。' });
  f.child.stderr.write('error: Error 524, Status: 524 unknown\n');
  f.result({ status: 'SUCCESS', error: '' });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).not.toHaveBeenCalled();
  expect(f.events.filter((event) => event.type === 'error')).toEqual([]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: false });
});

it.each(['cancelled', 'multiple-input', 'denied', 'exit', 'cleanup'])(
  '%s 不能仅凭累计结果判定成功',
  async (scenario) => {
    if (scenario === 'cleanup') vi.useFakeTimers();
    const read = vi.fn(async () => ({ trajectory: completedTrajectory() }));
    const f = await resumedTurn(true, read);
    f.step(4, 'user_input');
    if (scenario === 'cancelled') f.step(5, 'tool', 'CANCELLED');
    if (scenario === 'multiple-input') f.step(5, 'user_input');
    f.step(6, 'agent_response');
    f.result(scenario === 'denied' ? { denied_actions: [{ action: 'command' }] } : {});
    if (scenario === 'cleanup') await vi.advanceTimersByTimeAsync(2100);
    f.child.emit('close', scenario === 'exit' ? 3 : 0);
    await f.handle.done;
    expect(read).toHaveBeenCalledTimes(['cancelled', 'exit'].includes(scenario) ? 1 : 0);
    expectNativeFailure(f.events);
  },
);

it('流中已出现错误步骤但只读轨迹同索引未证实429时，不能用其他成功步骤覆盖', async () => {
  const read = vi.fn(async () => ({ trajectory: completedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(5, 'error_message');
  f.step(6, 'agent_response', 'DONE', { text_delta: '已经输出文本。' });
  f.result({ error: rateLimitError });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(read).toHaveBeenCalledOnce();
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it('原生复核超过预算时结束等待并保留失败', async () => {
  let reviewSignal: AbortSignal | undefined;
  const f = await resumedTurn(true, (_id, _dir, signal) => {
    reviewSignal = signal;
    return new Promise(() => {});
  });
  f.step(4, 'user_input');
  f.step(6, 'agent_response');
  f.result({ error: '' });
  f.child.emit('close', 0);
  await f.handle.done;
  expect(reviewSignal?.aborted).toBe(true);
  expectNativeFailure(f.events);
}, 7000);

it.each(['ERROR', 'DONE'])('本轮工具失败后答复完整但同文524归属不明：%s', async (state) => {
  const f = await resumedTurn(true, async () => ({ trajectory: completedTrajectory() }));
  f.step(4, 'user_input');
  f.step(5, 'tool', state, {
    tool_name: 'view_file',
    tool_info: { name: 'view_file', error: { type: 'TOOL_ERROR', message: '示例文件不存在' } },
  });
  f.step(6, 'agent_response', 'DONE', { text_delta: '已说明文件读取结果。' });
  f.result();
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events).toContainEqual(
    expect.objectContaining({ type: 'tool_result', isError: true, output: '示例文件不存在' }),
  );
  expectUnconfirmed(f.events, 'agy-step-6');
});

it('工具自己的 HTTP 500 不误报模型服务失败，同文累计错误归属仍不明', async () => {
  const f = await resumedTurn(true, async () => ({ trajectory: completedTrajectory() }));
  f.step(4, 'user_input');
  f.step(5, 'tool', 'ERROR', {
    tool_name: 'read_url',
    tool_info: { name: 'read_url', error: { type: 'TOOL_ERROR', message: 'HTTP 500: example tool service failed' } },
  });
  f.step(6, 'agent_response', 'DONE', { text_delta: '已说明工具服务不可用。' });
  f.result();
  f.child.emit('close', 0);
  await f.handle.done;
  expect(f.events).toContainEqual(
    expect.objectContaining({ type: 'tool_result', isError: true, output: 'HTTP 500: example tool service failed' }),
  );
  expectUnconfirmed(f.events, 'agy-step-6');
});

type Step = [number, string, string?, Record<string, unknown>?];
const completedSteps: Step[] = [
  [4, 'user_input'],
  [6, 'agent_response', 'DONE', { text_delta: '本轮答复。' }],
];
type IncompleteEvidence = {
  resume?: boolean;
  steps?: Step[];
  stderr?: string;
  result?: Record<string, unknown>;
  exit?: number;
};
const incompleteCases: [string, IncompleteEvidence][] = [
  ['非零退出', { exit: 3 }],
  ['首轮未续接', { resume: false, steps: [[0, 'user_input'], completedSteps[1]!] }],
  ['缺少本轮输入', { steps: [completedSteps[1]!] }],
  ['输入边界前已收到高索引错误', { steps: [[7, 'error_message'], ...completedSteps] }],
  ['缺少最终公开文本', { steps: [completedSteps[0]!, [6, 'agent_response']] }],
  ['最终答复未结束', { steps: [completedSteps[0]!, [6, 'agent_response', 'ACTIVE', { text_delta: '本轮答复。' }]] }],
  ['答复后仍有工具', { steps: [...completedSteps, [7, 'tool']] }],
  ['本轮有错误步骤', { steps: [completedSteps[0]!, [5, 'error_message'], completedSteps[1]!] }],
  ['错误后重复输入事件', { steps: [completedSteps[0]!, [5, 'error_message'], completedSteps[0]!, completedSteps[1]!] }],
  ['本轮步骤已取消', { steps: [completedSteps[0]!, [5, 'tool', 'CANCELLED'], completedSteps[1]!] }],
  [
    'DONE 工具仍有原生错误',
    {
      steps: [
        completedSteps[0]!,
        [
          5,
          'tool',
          'DONE',
          { tool_info: { name: 'run_command', error: { type: 'TOOL_ERROR', message: 'Error 524' } } },
        ],
        completedSteps[1]!,
      ],
    },
  ],
  ['原生 stderr 失败', { stderr: 'error: synthetic-native-failure\n' }],
  ['未知结果状态', { result: { status: 'UNKNOWN' } }],
  ['结果缺少会话身份', { result: { conversation_id: undefined } }],
  ['缺少结果答复', { result: { response: '' } }],
  ['结果仍含被拒绝的操作', { result: { denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } }],
];

it.each(incompleteCases)('续接 ERROR 遇到%s且无可靠复核时保留失败', async (_scenario, input) => {
  const f = await resumedTurn(input.resume);
  for (const step of input.steps ?? completedSteps) f.step(...step);
  if (input.stderr) f.child.stderr.write(input.stderr);
  f.result(input.result);
  f.child.emit('close', input.exit ?? 0);
  await f.handle.done;
  expectNativeFailure(f.events);
  expect(JSON.stringify(f.events)).not.toContain('synthetic-native-failure');
});

it('自动清理后的退出不能代替原生自然成功证据', async () => {
  vi.useFakeTimers();
  const f = await resumedTurn();
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。' });
  f.result();
  await vi.advanceTimersByTimeAsync(2100);
  f.child.emit('close', 0);
  await f.handle.done;
  expectNativeFailure(f.events, '524');
});

function cleanupResultFor(scenario: string): Record<string, unknown> {
  if (scenario === 'wrong-identity') return { conversation_id: 'another-session' };
  if (scenario === 'unknown-result') return { status: 'UNKNOWN' };
  return {};
}

function cleanupExitFor(scenario: string): [number | null, NodeJS.Signals | null] {
  if (scenario === 'external-exit') return [3, null];
  return [null, scenario === 'other-signal' ? 'SIGKILL' : 'SIGTERM'];
}

it.each([
  [0, null, 2100],
  [null, 'SIGTERM', 2100],
  [null, 'SIGKILL', 4100],
] as const)('结果后主机清理不能将原生失败改成未知：%s / %s', async (code, signal, delay) => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({ trajectory: completedTrajectory() }));
  const f = await resumedTurn(true, read);
  f.step(4, 'user_input');
  f.step(5, 'system_message');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。' });
  f.result();
  await vi.advanceTimersByTimeAsync(delay);
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  f.child.emit('close', code, signal);
  await f.handle.done;
  expect(read).not.toHaveBeenCalled();
  expectNativeFailure(f.events, '524');
});

it.each([
  'stderr-524',
  'current-error',
  'external-exit',
  'other-signal',
  'signal-not-sent',
  'interrupt',
  'wrong-identity',
  'unknown-result',
  'no-final-text',
] as const)('结果后主机清理遇到 %s 时保留失败', async (scenario) => {
  vi.useFakeTimers();
  const trajectory = completedTrajectory();
  const read = vi.fn(async () => ({ trajectory }));
  const f = await resumedTurn(true, read);
  if (scenario === 'signal-not-sent') f.child.kill.mockReturnValue(false);
  f.step(4, 'user_input');
  if (scenario === 'current-error') f.step(5, 'error_message');
  f.step(6, 'agent_response', 'DONE', scenario === 'no-final-text' ? {} : { text_delta: '本轮答复。' });
  if (scenario === 'stderr-524') f.child.stderr.write('error: Error 524\n');
  f.result(cleanupResultFor(scenario));
  await vi.advanceTimersByTimeAsync(2100);
  const interrupted = scenario === 'interrupt' ? f.handle.interrupt() : undefined;
  f.child.emit('close', ...cleanupExitFor(scenario));
  await interrupted;
  await f.handle.done;
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  expect(read).not.toHaveBeenCalled();
});

it('结果后主机清理不能掩盖真实的非零退出码', async () => {
  vi.useFakeTimers();
  const f = await resumedTurn();
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。' });
  f.result({ status: 'SUCCESS', error: '' });
  await vi.advanceTimersByTimeAsync(2100);
  f.child.emit('close', 3, null);
  await f.handle.done;
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it.each([false, true])('结果后中断且错误来源未核实时保留取消状态，已有清理：%s', async (afterCleanup) => {
  vi.useFakeTimers();
  const f = await resumedTurn();
  f.step(4, 'user_input');
  f.step(6, 'agent_response', 'DONE', { text_delta: '本轮答复。' });
  f.result();
  if (afterCleanup) await vi.advanceTimersByTimeAsync(2100);
  const interrupted = f.handle.interrupt();
  f.child.emit('close', null, 'SIGTERM');
  await interrupted;
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'error')).toEqual([]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it.each(['natural', 'cleanup', 'interrupt'] as const)(
  '本轮仅 result 报 524，历史错误不同且最终答复完成时不得判成功：%s',
  async (ending) => {
    vi.useFakeTimers();
    const trajectory = completedTrajectory();
    Object.assign(trajectory.steps[3]!, {
      errorMessage: { error: { userErrorMessage: 'Error 500: synthetic historical failure' } },
    });
    const read = vi.fn(async () => ({ trajectory }));
    const f = await resumedTurn(true, read);
    f.step(4, 'user_input');
    f.step(6, 'agent_response', 'DONE', { text_delta: '已输出的片段。' });
    f.result({ error: 'Error 524: synthetic current failure' });
    if (ending === 'cleanup') await vi.advanceTimersByTimeAsync(2100);
    const interrupted = ending === 'interrupt' ? f.handle.interrupt() : undefined;
    f.child.emit('close', ending === 'natural' ? 0 : null, ending === 'natural' ? null : 'SIGTERM');
    await interrupted;
    await f.handle.done;
    expect(read).toHaveBeenCalledTimes(ending === 'natural' ? 1 : 0);
    if (ending === 'interrupt') {
      expect(f.events.filter((event) => event.type === 'error')).toEqual([]);
      expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
    } else expectNativeFailure(f.events, '524');
  },
);

it.each(['stderr', 'step'] as const)('结果后中断保留错误并区分明确诊断与未知归属：%s', async (source) => {
  const f = await resumedTurn();
  f.step(4, 'user_input');
  if (source === 'stderr') f.child.stderr.write('error: Error 524\n');
  else f.step(5, 'error_message');
  f.step(6, 'agent_response', 'DONE', { text_delta: '已输出的片段。' });
  f.result();
  const interrupted = f.handle.interrupt();
  f.child.emit('close', null, 'SIGTERM');
  await interrupted;
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'error')).toEqual(
    source === 'stderr' ? [{ type: 'error', message: expect.stringContaining('模型服务响应超时') }] : [],
  );
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
});

it('工具成功后模型服务 HTTP 524 的真实失败给出一次脱敏原因', async () => {
  const f = await resumedTurn();
  f.step(4, 'user_input');
  f.step(5, 'tool');
  f.step(6, 'error_message');
  const error = `${previousError}; token=synthetic-secret; https://private.invalid/path`;
  f.result({ error, response: '' });
  f.child.stderr.write(`error: ${error}\nAGY_ERROR: ${JSON.stringify({ short_error: error })}\n`);
  f.child.emit('close', 3);
  await f.handle.done;
  expect(f.events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining('524') },
  ]);
  expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  expect(JSON.stringify(f.events)).not.toMatch(/synthetic-secret|private\.invalid/);
});
