import { expect, it } from 'vitest';
import { antigravityHistory } from '../../../../src/agents/antigravity/history/history';
import type { ManagementRecord } from '../../../../src/agents/antigravity/management/management-rpc';

function fixture(index = 1, metadataIndex?: number) {
  return {
    cascadeId: 'session',
    trajectoryId: 'trajectory',
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: '合成回复' },
        metadata: {
          executionId: 'generation',
          modelUsage: { model: 'INTERNAL_MODEL_ENUM' },
          sourceTrajectoryStepInfo: {
            cascadeId: 'session',
            trajectoryId: 'trajectory',
            stepIndex: index,
            ...(metadataIndex === undefined ? {} : { metadataIndex }),
          },
        },
      },
    ],
    generatorMetadataOffset: metadataIndex ?? 0,
    generatorMetadata: [
      {
        executionId: 'generation',
        stepIndices: [index],
        chatModel: { responseModel: 'reported-model-version' },
      },
    ],
  };
}

it.each([
  [1, undefined],
  [23, 7],
] as const)('按绝对步骤 %s 配对响应模型，兼容省略的零索引与分页偏移', (index, generator) => {
  const events = antigravityHistory(fixture(index, generator), { offset: index });
  expect(events.find((event) => event.type === 'text')).toEqual({
    type: 'text',
    id: `agy-step-${index}`,
    delta: '合成回复',
    responseModel: 'reported-model-version',
  });
});

it('会话、轨迹、执行或步骤不一致时不借用其他回复的型号', () => {
  const changes: ((value: ReturnType<typeof fixture>) => void)[] = [
    (v) => {
      v.steps[0]!.metadata.sourceTrajectoryStepInfo.cascadeId = 'other';
    },
    (v) => {
      v.steps[0]!.metadata.sourceTrajectoryStepInfo.trajectoryId = 'other';
    },
    (v) => {
      v.steps[0]!.metadata.sourceTrajectoryStepInfo.stepIndex = 3;
    },
    (v) => {
      v.generatorMetadata[0]!.executionId = 'other';
    },
    (v) => {
      v.generatorMetadata[0]!.stepIndices = [2];
    },
    (v) => {
      v.generatorMetadata[0]!.stepIndices = [1, 2];
    },
    (v) => {
      v.generatorMetadataOffset = 1;
    },
  ];
  for (const change of changes) {
    const value = fixture();
    change(value);
    expect(antigravityHistory(value, { offset: 1 }).find((event) => event.type === 'text')).not.toHaveProperty(
      'responseModel',
    );
  }
});

it.each(['', '<synthetic>', 'model\nsecret', 'x'.repeat(161)])('无有效响应型号时不从配置或内部枚举补猜', (model) => {
  const value = fixture();
  value.generatorMetadata[0]!.chatModel.responseModel = model;
  const trajectory: ManagementRecord = { ...value, model: 'configured-model' };
  expect(antigravityHistory(trajectory, { offset: 1 }).find((event) => event.type === 'text')).not.toHaveProperty(
    'responseModel',
  );
});
