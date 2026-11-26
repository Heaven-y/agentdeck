import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { AntigravityMapper } from '../../../../src/agents/antigravity/run/mapper';
import { antigravityHistory } from '../../../../src/agents/antigravity/history/history';

it('上下文保留最近同次生成的输入计量和预算，不用实际输入覆盖估计占用', () => {
  const generator = (used: number, usage?: unknown) => ({
    chatModel: {
      usage,
      chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: used, maxContextTokens: 512000 } },
    },
  });
  const previous = generator(300000, { inputTokens: '100', cacheReadTokens: '200000' });
  const latest = generator(335679, { inputTokens: '2993', cacheReadTokens: '506338' });
  expect(antigravityHistory({ generatorMetadata: [previous, latest] }).at(-1)).toMatchObject({
    type: 'context',
    usage: {
      usedTokens: 335679,
      lastRequest: { inputTokens: 2993, cachedInputTokens: 506338, inputBudgetTokens: 512000 },
    },
  });
  const after = antigravityHistory({ generatorMetadata: [latest, generator(19209)] }).at(-1);
  expect(after).toMatchObject({ type: 'context', usage: { usedTokens: 19209 } });
  expect(after).not.toHaveProperty('usage.lastRequest');
});

it('历史额度错误显示具体原因，旧倒计时不当作当前剩余时间且不污染下一轮', () => {
  const step = (type: string, extra = {}) => ({
    type: `CORTEX_STEP_TYPE_${type}`,
    status: 'CORTEX_STEP_STATUS_DONE',
    ...extra,
  });
  const events = antigravityHistory({
    steps: [
      step('USER_INPUT', { userInput: { query: '先运行' } }),
      step('ERROR_MESSAGE', {
        errorMessage: {
          shouldShowUser: true,
          error: { userErrorMessage: 'Individual quota reached. Resets in 2h5m. token=synthetic-secret' },
        },
      }),
      step('USER_INPUT', { userInput: { query: '稍后继续' } }),
      step('PLANNER_RESPONSE', { plannerResponse: { response: '已完成' } }),
    ],
  });
  expect(events.filter((event) => event.type === 'error')).toEqual([
    { type: 'error', message: expect.stringContaining('额度已用尽') },
  ]);
  expect(events.filter((event) => event.type === 'turn_end')).toMatchObject([{ isError: true }, { isError: false }]);
  expect(JSON.stringify(events)).not.toMatch(/2h5m|synthetic-secret/);
});

it('原生 ERROR 工具步骤及时结束并显示错误，重复事件去重，取消不伪装成功', () => {
  const cwd = path.join(tmpdir(), 'agentdeck-error-observability');
  const mapper = new AntigravityMapper(cwd);
  mapper.map({ event: 'init', conversation_id: 'session', init: { cwd } });
  const step = { conversation_id: 'session', step_index: 2, step_type: 'tool', tool_name: 'write_file' };
  expect(mapper.map({ event: 'step_update', step_update: { ...step, state: 'ACTIVE' } })).toMatchObject([
    { type: 'tool_call', id: 'agy-step-2' },
  ]);
  const failed = {
    event: 'step_update',
    step_update: {
      ...step,
      state: 'ERROR',
      duration_seconds: 0.02,
      tool_info: { name: 'write_file', error: { type: 'TOOL_ERROR', message: '文件不可写' } },
    },
  };
  expect(mapper.map(failed)).toEqual([
    {
      type: 'tool_result',
      id: 'agy-step-2',
      output: '文件不可写',
      isError: true,
      durationMs: 20,
      timingSource: 'native',
    },
  ]);
  expect(mapper.map(failed)).toEqual([]);
  expect(mapper.map({ event: 'step_update', step_update: { ...step, step_index: 3, state: 'CANCELLED' } })).toEqual([
    { type: 'tool_call', id: 'agy-step-3', name: 'write_file', input: {} },
  ]);
});

it('按原生步骤统计并去重，不把累计结果冒充本轮 token 或耗时', () => {
  const cwd = path.join(tmpdir(), 'agentdeck-observability');
  const mapper = new AntigravityMapper(cwd);
  mapper.map({ event: 'init', conversation_id: 'session', init: { cwd } });
  const update = {
    event: 'step_update',
    step_update: {
      conversation_id: 'session',
      step_type: 'agent_response',
      step_index: 1,
      state: 'DONE',
      duration_seconds: 2,
      usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5 },
    },
  };
  expect(mapper.map(update)).toEqual([
    {
      type: 'step_usage',
      id: 'agy-step-1',
      durationMs: 2000,
      timingSource: 'native',
      usage: { source: 'antigravity', scope: 'step', inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5 },
    },
  ]);
  expect(mapper.map(update)).toEqual([]);
  mapper.map({
    event: 'result',
    result: { conversation_id: 'session', status: 'SUCCESS', duration_seconds: 999, usage: { output_tokens: 9000 } },
  });
  expect(mapper.result).toEqual({ type: 'turn_end', isError: false });
});

it('子代理保留可见摘要和状态，不回传日志路径或工作区列表', () => {
  const cwd = path.join(tmpdir(), 'agentdeck-subagent-observability');
  const mapper = new AntigravityMapper(cwd);
  mapper.map({ event: 'init', conversation_id: 'session', init: { cwd } });
  const update = {
    event: 'step_update',
    step_update: {
      conversation_id: 'session',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      subagent_info: {
        subagents: [
          {
            type_name: 'explorer',
            role: '读取文件',
            conversation_id: 'child',
            log_uri: 'hidden-log',
            workspace_uris: ['hidden-workspace'],
          },
        ],
      },
    },
  };
  const events = mapper.map(update);
  expect(events).toMatchObject([{ type: 'activity', id: 'agy-step-2', name: '子代理', status: 'running' }]);
  expect(JSON.stringify(events)).not.toContain('hidden-');
  expect(mapper.map(update)).toEqual([]);
});

it('回放工具、文件、错误和压缩，保留原生耗时，隐藏内部诊断与思考签名', () => {
  const done = 'CORTEX_STEP_STATUS_DONE';
  const events = antigravityHistory({
    steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: done, userInput: { query: '示例任务' } },
      {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: done,
        metadata: { startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z' },
        runCommand: {
          commandLine: 'echo demo',
          exitCode: 1,
          combinedOutput: { full: 'demo' },
          rawDebugOutput: 'hidden-debug',
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        status: done,
        viewFile: { absolutePathUri: pathToFileURL(path.join(tmpdir(), 'demo.txt')).href, content: '示例文件' },
      },
      {
        type: 'CORTEX_STEP_TYPE_MCP_TOOL',
        status: done,
        mcpTool: {
          serverName: 'my-server',
          toolCall: { name: 'lookup', argumentsJson: '{"query":"example"}' },
          resultString: '找到一项',
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: done,
        generic: { args: { query: 'demo' }, result: { result: '输出', payload: { secret: 'hidden-any' } } },
      },
      {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: done,
        errorMessage: { shouldShowUser: true, error: { userErrorMessage: '可见错误', fullError: 'hidden-error' } },
      },
      { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: done, checkpoint: {} },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: done,
        plannerResponse: { response: '完成', rawThinking: 'hidden-thinking', signature: 'hidden-signature' },
      },
      { type: 'CORTEX_STEP_TYPE_NEW_ACTIVITY', status: done, customExtensions: { payload: 'hidden-payload' } },
    ],
    generatorMetadata: [
      {
        chatModel: {
          chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 1000, maxContextTokens: 10000 } },
        },
      },
    ],
  });
  expect(events).toContainEqual({
    type: 'tool_result',
    id: 'agy-step-1',
    output: 'demo',
    isError: true,
    durationMs: 2000,
    timingSource: 'native',
  });
  expect(events).toContainEqual({ type: 'tool_result', id: 'agy-step-2', output: '示例文件', isError: false });
  expect(events).toContainEqual({ type: 'error', message: '可见错误' });
  expect(events).toContainEqual({ type: 'compaction', state: { status: 'completed' } });
  expect(events.at(-1)).toEqual({
    type: 'context',
    usage: { source: 'antigravity_estimate', usedTokens: 1000, windowTokens: 10000, percentage: 10 },
  });
  expect(JSON.stringify(events)).not.toContain('hidden-');
  expect(events).toContainEqual({
    type: 'activity',
    id: 'agy-step-8',
    name: 'NEW_ACTIVITY',
    status: 'completed',
    input: { type: 'CORTEX_STEP_TYPE_NEW_ACTIVITY', status: done },
  });
});

it('未完成工具和缺失统计不填零，不生成成功结果或 tok/s', () => {
  const events = antigravityHistory({
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_INTERRUPTED',
        runCommand: { commandLine: 'demo' },
      },
    ],
  });
  expect(events.map((event) => event.type)).toEqual(['tool_call', 'turn_end']);
  expect(events.at(-1)).not.toHaveProperty('forkPoint');
  expect(events.at(-1)).not.toHaveProperty('usage');
  expect(events.at(-1)).not.toHaveProperty('durationMs');
});

it('工具自己的 HTTP 524 仅留在工具卡片，不把完整回复变成回合失败', () => {
  const cwd = path.join(tmpdir(), 'agentdeck-tool-error');
  const mapper = new AntigravityMapper(cwd);
  mapper.map({ event: 'init', conversation_id: 'fixture', init: { cwd } });
  const message = 'HTTP 524: 工具服务超时; token=synthetic-secret';
  const output = '工具请求超时（HTTP 524）。';
  const live = mapper.map({
    event: 'step_update',
    step_update: {
      conversation_id: 'fixture',
      step_index: 1,
      step_type: 'tool',
      tool_name: 'run_command',
      state: 'ERROR',
      tool_info: { name: 'run_command', error: { type: 'TOOL_ERROR', message } },
    },
  });
  expect(live).toContainEqual(expect.objectContaining({ type: 'tool_result', isError: true, output }));
  expect(live.some((event) => event.type === 'error')).toBe(false);
  const replay = antigravityHistory({
    steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { query: '测试' } },
      {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_ERROR',
        error: { type: 'TOOL_ERROR', userErrorMessage: message },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: '已说明结果' },
      },
    ],
  });
  expect(replay).toContainEqual(expect.objectContaining({ type: 'tool_result', isError: true, output }));
  expect(JSON.stringify([live, replay])).not.toContain('synthetic-secret');
  expect(replay.some((event) => event.type === 'error')).toBe(false);
  expect(replay.at(-1)).toMatchObject({ type: 'turn_end', isError: false });
});
