import { expect, it } from 'vitest';
import { antigravityHistory } from '../../../src/agents/antigravity/history';

function fixture() {
  const usage = {
    inputTokens: '100',
    outputTokens: '25',
    cacheReadTokens: '800',
    thinkingOutputTokens: '5',
    responseOutputTokens: '20',
  };
  return {
    cascadeId: 'synthetic-session',
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: '合成回复' },
        metadata: {
          modelUsage: usage,
          executionId: 'run',
          sourceTrajectoryStepInfo: { metadataIndex: 0, stepIndex: 0, cascadeId: 'synthetic-session' },
        },
      },
    ],
    generatorMetadata: [
      {
        stepIndices: [0],
        executionId: 'run',
        chatModel: {
          usage,
          timeToFirstToken: '0.150s',
          streamingDuration: '0.200s',
          retryInfos: [{ usage }],
        },
      },
    ],
  };
}

function responseWithMetadata(metadata: Record<string, unknown>, status = 'CORTEX_STEP_STATUS_DONE') {
  const value = fixture();
  const step = value.steps[0]!;
  return { ...value, steps: [{ ...step, status, metadata: { ...step.metadata, ...metadata } }] };
}

it('历史回复按创建至生成结束恢复步骤耗时，与流式生成耗时分开', () => {
  const events = antigravityHistory(
    responseWithMetadata({
      createdAt: '2026-03-01T04:00:00.1252500Z',
      finishedGeneratingAt: '2026-03-01T04:00:05.6255000Z',
      startedAt: '2026-03-01T04:00:05.6255000Z',
      completedAt: '2026-03-01T04:00:05.6255000Z',
    }),
  );
  expect(events.find((event) => event.type === 'step_usage')).toMatchObject({
    durationMs: 5500.25,
    timingSource: 'native',
    usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 800, reasoningOutputTokens: 5 },
    generation: { firstTokenMs: 150, durationMs: 200 },
  });
});

it('历史回复兼容原生时间戳对象', () => {
  const events = antigravityHistory(
    responseWithMetadata({
      createdAt: { seconds: '1700000000', nanos: 125250000 },
      finishedGeneratingAt: { seconds: '1700000005', nanos: 625500000 },
    }),
  );
  expect(events.find((event) => event.type === 'step_usage')).toMatchObject({ durationMs: 5500.25 });
});

it.each([
  ['缺少创建时间', { finishedGeneratingAt: '2026-03-01T04:00:05Z' }],
  ['缺少生成结束时间', { createdAt: '2026-03-01T04:00:00Z' }],
  ['时间倒序', { createdAt: '2026-03-01T04:00:05Z', finishedGeneratingAt: '2026-03-01T04:00:00Z' }],
  ['时间相等', { createdAt: '2026-03-01T04:00:00Z', finishedGeneratingAt: '2026-03-01T04:00:00Z' }],
  ['格式非法', { createdAt: '0', finishedGeneratingAt: '2026-03-01T04:00:05Z' }],
  ['日期非法', { createdAt: '2026-02-30T04:00:00Z', finishedGeneratingAt: '2026-03-03T04:00:00Z' }],
  [
    '纳秒非法',
    { createdAt: { seconds: '1700000000', nanos: 'invalid' }, finishedGeneratingAt: { seconds: '1700000001' } },
  ],
  ['仅有旧起止时间', { startedAt: '2026-03-01T04:00:00Z', completedAt: '2026-03-01T04:00:05Z' }],
])('历史回复%s时不推算步骤耗时', (_label, metadata) => {
  const event = antigravityHistory(responseWithMetadata(metadata)).find((entry) => entry.type === 'step_usage');
  expect(event).toMatchObject({ generation: { durationMs: 200 } });
  expect(event).not.toHaveProperty('durationMs');
});

it('只有完成且有用量的回复才产生步骤统计', () => {
  const timing = { createdAt: '2026-03-01T04:00:00Z', finishedGeneratingAt: '2026-03-01T04:00:05Z' };
  expect(
    antigravityHistory(responseWithMetadata(timing, 'CORTEX_STEP_STATUS_ERROR')).find(
      (event) => event.type === 'step_usage',
    ),
  ).toBeUndefined();
  expect(
    antigravityHistory(responseWithMetadata({ ...timing, modelUsage: {} })).find(
      (event) => event.type === 'step_usage',
    ),
  ).toBeUndefined();
});

it('原生历史将同一次生成的首段等待和流式耗时与工具耗时分开', () => {
  const events = antigravityHistory(fixture());
  expect(events.find((event) => event.type === 'step_usage')).toMatchObject({
    usage: { outputTokens: 25, reasoningOutputTokens: 5 },
    generation: { firstTokenMs: 150, durationMs: 200 },
  });
  expect(events.find((event) => event.type === 'step_usage')).not.toHaveProperty('durationMs');
});

it('生成索引、执行身份、用量不一致或多步骤共用生成时隐藏计时', () => {
  const changes = [
    (value: ReturnType<typeof fixture>) => {
      value.steps[0]!.metadata.sourceTrajectoryStepInfo.metadataIndex = 2;
    },
    (value: ReturnType<typeof fixture>) => {
      value.steps[0]!.metadata.sourceTrajectoryStepInfo.stepIndex = 3;
    },
    (value: ReturnType<typeof fixture>) => {
      value.steps[0]!.metadata.sourceTrajectoryStepInfo.cascadeId = 'other';
    },
    (value: ReturnType<typeof fixture>) => {
      value.generatorMetadata[0]!.executionId = 'other';
    },
    (value: ReturnType<typeof fixture>) => {
      value.generatorMetadata[0]!.stepIndices.push(1);
    },
    (value: ReturnType<typeof fixture>) => {
      value.generatorMetadata[0]!.chatModel.usage = {
        ...value.generatorMetadata[0]!.chatModel.usage,
        outputTokens: '26',
      };
    },
  ];
  for (const change of changes) {
    const value = fixture();
    change(value);
    expect(antigravityHistory(value).find((event) => event.type === 'step_usage')).not.toHaveProperty('generation');
  }
});

it('多次尝试与非法生成时间不算生成速度', () => {
  const value = fixture();
  value.generatorMetadata[0]!.chatModel.retryInfos.push({ usage: value.generatorMetadata[0]!.chatModel.usage });
  expect(antigravityHistory(value).find((event) => event.type === 'step_usage')).not.toHaveProperty('generation');
  for (const duration of ['0s', '-1s', 'Infinitys', '100000000000000s', '1e3s', '']) {
    const value = fixture();
    value.generatorMetadata[0]!.chatModel.streamingDuration = duration;
    expect(antigravityHistory(value).find((event) => event.type === 'step_usage')).not.toHaveProperty('generation');
  }
});
