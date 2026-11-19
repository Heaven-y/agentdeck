import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createAntigravitySessionManagement } from '../../../../src/agents/antigravity/management/management';
import {
  NativeTrajectoryMissing,
  type ManagementRecord,
} from '../../../../src/agents/antigravity/management/management-rpc';

const dir = path.join(tmpdir(), 'agentdeck-agy-management');
const uri = pathToFileURL(dir).href;
function detail(id = 'source', overrides: ManagementRecord = {}) {
  return {
    status: 'CASCADE_RUN_STATUS_IDLE',
    trajectory: {
      cascadeId: id,
      metadata: { workspaceUris: [uri] },
      steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' }],
      ...overrides,
    },
  };
}
function fixture(source: ManagementRecord = detail()) {
  const request = vi.fn(async (method: string, input: ManagementRecord): Promise<ManagementRecord> => {
    if (method === 'ForkConversation') return { newCascadeId: 'forked' };
    if (method === 'GetCascadeTrajectory')
      return input.cascadeId === 'source'
        ? source
        : detail('forked', {
            parentReferences: [{ conversationId: 'source' }],
          });
    return {};
  });
  const close = vi.fn(async () => {});
  const backend = vi.fn(async () => ({ request, close }));
  const summaryReady = vi.fn(() => true);
  const service = createAntigravitySessionManagement({ backend, summaryReady });
  return { request, close, backend, summaryReady, service };
}

it('单步骤分支接收 proto 省略的零下标，使用原生 fork 并等待摘要，不发送 prompt', async () => {
  const f = fixture();
  f.summaryReady.mockReturnValueOnce(false).mockReturnValue(true);
  expect(await f.service.fork('source', dir, {})).toEqual({ sessionId: 'forked' });
  expect(f.request).toHaveBeenCalledWith('ForkConversation', {
    sourceCascadeId: 'source',
    forkAtStepIndex: 0,
    targetForkWorkspace: 'FORK_TARGET_CURRENT_WORKSPACE',
    sourceWorkspaceUris: [uri],
  });
  expect(f.summaryReady).toHaveBeenCalledTimes(2);
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    'GetCascadeTrajectory',
    'ForkConversation',
    'GetCascadeTrajectory',
  ]);
  expect(f.close).toHaveBeenCalledOnce();
});

it('历史读取在身份校验后补齐原生分页，空页不冒充完整历史', async () => {
  const f = fixture();
  f.request
    .mockResolvedValueOnce({
      ...detail('source', { generatorMetadata: [{ chatModel: {} }] }),
      numTotalSteps: 2,
      numTotalGeneratorMetadata: 5,
    })
    .mockResolvedValueOnce({
      steps: [{ type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_DONE' }],
    });
  const result = await f.service.readTrajectory!('source', dir);
  expect(result.trajectory.steps).toHaveLength(2);
  expect(result.trajectory.generatorMetadata).toEqual([]);
  expect(f.request).toHaveBeenLastCalledWith(
    'GetCascadeTrajectorySteps',
    { cascadeId: 'source', stepOffset: 1, trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_FULL' },
    'history',
  );
  expect(f.close).toHaveBeenCalledOnce();
  f.request.mockResolvedValueOnce({ ...detail(), numTotalSteps: 2 }).mockResolvedValueOnce({ steps: [] });
  await expect(f.service.readTrajectory!('source', dir)).rejects.toMatchObject({ code: 'session_history_incomplete' });
});

it('用于回合判定的读取拒绝未知总数及分页过程中有新步骤的轨迹', async () => {
  const f = fixture();
  await expect(f.service.readTurnTrajectory!('source', dir)).rejects.toMatchObject({
    code: 'session_history_incomplete',
  });
  const step = { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' };
  const first = { ...detail(), numTotalSteps: 2 };
  f.request
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({ steps: [step] })
    .mockResolvedValueOnce({ ...first, numTotalSteps: 3 });
  await expect(f.service.readTurnTrajectory!('source', dir)).rejects.toMatchObject({
    code: 'session_history_incomplete',
  });
  f.request
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({ steps: [step] })
    .mockResolvedValueOnce({ ...detail('source', { steps: [{ ...step, error: 'Error 524' }] }), numTotalSteps: 2 });
  await expect(f.service.readTurnTrajectory!('source', dir)).rejects.toMatchObject({
    code: 'session_history_incomplete',
  });
  f.request
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({ steps: [step] })
    .mockResolvedValueOnce(first);
  await expect(f.service.readTurnTrajectory!('source', dir)).resolves.toMatchObject({
    trajectory: { steps: [step, step] },
  });
});

it.each([
  ['wrong id', detail('other'), 'session_missing'],
  [
    'wrong cwd',
    detail('source', { metadata: { workspaceUris: [pathToFileURL(path.join(tmpdir(), 'other')).href] } }),
    'session_missing',
  ],
  [
    'multi cwd',
    detail('source', { metadata: { workspaceUris: [uri, pathToFileURL(path.join(tmpdir(), 'other')).href] } }),
    'session_missing',
  ],
  [
    'subagent',
    detail('source', { metadata: { workspaceUris: [uri], parentConversationId: 'parent' } }),
    'unsupported_action',
  ],
  ['busy', { ...detail(), status: 'CASCADE_RUN_STATUS_RUNNING' }, 'session_busy'],
])('修改前拒绝不匹配或运行中的原生会话：%s', async (_name, source, code) => {
  const f = fixture(source);
  await expect(f.service.delete('source', dir)).rejects.toMatchObject({ code });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledOnce();
});

it('分支复核源身份，不能把另一条新会话当作成功分支', async () => {
  const f = fixture();
  f.request
    .mockResolvedValueOnce(detail())
    .mockResolvedValueOnce({ newCascadeId: 'forked' })
    .mockResolvedValueOnce(detail('forked', { parentReferences: [{ conversationId: 'other' }] }));
  await expect(f.service.fork('source', dir, {})).rejects.toMatchObject({ code: 'session_runtime_failed' });
  expect(f.summaryReady).not.toHaveBeenCalled();
});

it.each([
  [[], {}],
  [[{ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' }], {}],
  [[{ status: 'CORTEX_STEP_STATUS_DONE' }], { pointId: 'unknown' }],
])('无消息、无回复与非法位置不发原生分支请求', async (steps, input) => {
  const f = fixture(detail('source', { steps }));
  await expect(f.service.fork('source', dir, input)).rejects.toMatchObject({ code: 'invalid_fork_point' });
  expect(f.request).toHaveBeenCalledTimes(1);
});

it('删除轨迹和原生摘要后，只有原生不存在响应才确认成功', async () => {
  const f = fixture();
  f.summaryReady.mockReturnValue(false);
  f.request
    .mockResolvedValueOnce(detail())
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new NativeTrajectoryMissing())
    .mockResolvedValueOnce({});
  await f.service.delete('source', dir);
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    'GetCascadeTrajectory',
    'DeleteCascadeTrajectory',
    'GetCascadeTrajectory',
    'JetboxDeleteSummary',
  ]);
  expect(f.close).toHaveBeenCalledOnce();
});

it('删除后无法通信仍为未确认，不能把超时伪装成成功', async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce(detail()).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('timeout'));
  await expect(f.service.delete('source', dir)).rejects.toThrow('timeout');
});

it('删除轨迹后摘要清理失败可以安全重试，但再次核对摘要的目录归属', async () => {
  const f = fixture();
  f.summaryReady.mockReturnValue(false);
  const matches = vi.fn(async () => true);
  const service = createAntigravitySessionManagement({
    backend: f.backend,
    summaryReady: f.summaryReady,
    summaryMatches: matches,
  });
  f.request
    .mockResolvedValueOnce(detail())
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new NativeTrajectoryMissing())
    .mockRejectedValueOnce(new Error('index unavailable'));
  await expect(service.delete('source', dir)).rejects.toThrow('index unavailable');
  f.request.mockRejectedValueOnce(new NativeTrajectoryMissing()).mockResolvedValueOnce({});
  await service.delete('source', dir);
  expect(matches).toHaveBeenCalledWith('source', dir);
  expect(f.request.mock.calls.filter(([method]) => method === 'DeleteCascadeTrajectory')).toHaveLength(1);
  matches.mockResolvedValue(false);
  f.request.mockRejectedValueOnce(new NativeTrajectoryMissing());
  await expect(service.delete('source', dir)).rejects.toMatchObject({ code: 'session_missing' });
  expect(f.request.mock.calls.filter(([method]) => method === 'JetboxDeleteSummary')).toHaveLength(2);
});

it('重命名只合并原生 title，保留其他 annotations', async () => {
  const f = fixture();
  await f.service.rename!('source', dir, ' 新名称 ');
  expect(f.request).toHaveBeenLastCalledWith('UpdateConversationAnnotations', {
    cascadeId: 'source',
    annotations: { title: '新名称' },
    mergeAnnotations: true,
  });
});

it('关闭管理器会关闭活跃后端并拒绝后续调用', async () => {
  const f = fixture();
  let release!: (value: ManagementRecord) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const deleting = f.service.delete('source', dir);
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  await f.service.dispose();
  expect(f.close).toHaveBeenCalledOnce();
  release(detail('wrong'));
  await expect(deleting).rejects.toMatchObject({ code: 'session_missing' });
  await expect(f.service.delete('source', dir)).rejects.toMatchObject({ code: 'session_runtime_failed' });
  expect(f.backend).toHaveBeenCalledOnce();
});

it('原生旧首包被裁剪时从末尾分支仍取原生最后一步，保留目标身份核对', async () => {
  const step = { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' };
  const f = fixture({ ...detail(), numTotalSteps: 10 });
  const impl = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, input) =>
    method === 'GetCascadeTrajectory' && input.cascadeId === 'forked'
      ? detail('forked', { parentReferences: [{ conversationId: 'source', stepIndex: 9 }] })
      : impl(method, input),
  );
  const backend = async () => ({
    request: f.request,
    close: f.close,
    readInitialUpdate: async (params: ManagementRecord) => {
      const pageBounds = params.initialStepsPageBounds as { startIndex: number; endIndexExclusive: number };
      const empty = pageBounds.endIndexExclusive === 0;
      return {
        conversationId: 'source',
        trajectoryId: 'root-record',
        status: 'CASCADE_RUN_STATUS_IDLE',
        mainTrajectoryUpdate: {
          metadata: { workspaceUris: [uri] },
          stepsUpdate: { pageBounds, totalLength: 10, steps: empty ? [] : [step], indices: empty ? [] : [9] },
        },
      };
    },
  });
  const service = createAntigravitySessionManagement({ backend, summaryReady: f.summaryReady });
  expect(await service.fork('source', dir, {})).toEqual({ sessionId: 'forked' });
  expect(f.request.mock.calls.map(([method, input]) => [method, input.cascadeId ?? input.forkAtStepIndex])).toEqual([
    ['ForkConversation', 9],
    ['GetCascadeTrajectory', 'forked'],
  ]);
});
