import { expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeRuntime } from '../../../../src/agents/claude/run/runtime';
import type { QueryFn } from '../../../../src/agents/claude/run/query';
import { ClaudeElicitationOwner } from '../../../../src/agents/claude/interaction/elicitation-owner';
import type { AgentTurnInput } from '../../../../src/agents/contracts';
import {
  askClaudeQuestion,
  claudeElicitation,
  claudeElicitationCompleted,
} from '../../../../src/agents/claude/interaction/interactions';
const context = { runtimeId: 'runtime', signal: new AbortController().signal };
it('URL原生身份重复、外来完成和过期不能接管正在等待的接收方', async () => {
  vi.useFakeTimers();
  const requestInteraction = vi
    .fn<NonNullable<AgentTurnInput['requestInteraction']>>()
    .mockResolvedValue({ action: 'submit', values: {} });
  const completeInteraction = vi.fn();
  const owner = new ClaudeElicitationOwner('runtime', () => ({
    input: { requestInteraction, completeInteraction } as unknown as AgentTurnInput,
    sessionId: 'session',
  }));
  const request = {
    serverName: 'fixture',
    mode: 'url' as const,
    message: '授权',
    url: 'https://example.test',
    elicitationId: 'auth',
  };
  const context = { requestId: 'operation', signal: new AbortController().signal };
  try {
    await owner.request(request, context);
    owner.complete({
      type: 'system',
      subtype: 'elicitation_complete',
      mcp_server_name: 'fixture',
      elicitation_id: 'auth',
      session_id: 'foreign',
    });
    expect(completeInteraction).not.toHaveBeenCalled();
    expect(await owner.request(request, context)).toEqual({ action: 'cancel' });
    vi.advanceTimersByTime(300_001);
    expect(await owner.request(request, context)).toEqual({ action: 'accept' });
    owner.complete({ type: 'system', subtype: 'elicitation_complete' });
    owner.complete({
      type: 'system',
      subtype: 'elicitation_complete',
      mcp_server_name: 'unknown',
      elicitation_id: 'other',
    });
    requestInteraction.mockResolvedValueOnce({ action: 'cancel' });
    expect(await owner.request({ ...request, elicitationId: 'cancelled' }, context)).toEqual({ action: 'cancel' });
    expect(await owner.request({ ...request, elicitationId: 'cancelled' }, context)).toEqual({ action: 'accept' });
  } finally {
    owner.close();
    vi.useRealTimers();
  }
});
it('空闲表单归最新页面，授权完成仍回到创建该操作的页面而非后来回合', async () => {
  let options!: Options;
  let count = 0;
  const queryFn: QueryFn = (params) => {
    options = params.options;
    return Object.assign(
      (async function* () {
        for await (const _ of params.prompt) {
          count++;
          if (count === 3)
            yield {
              type: 'system',
              subtype: 'elicitation_complete',
              mcp_server_name: 'fixture',
              elicitation_id: 'auth',
              session_id: 'session',
            };
          yield { type: 'result', subtype: 'success', usage: { output_tokens: 1 } };
        }
      })(),
      {
        close: () => {},
        interrupt: async () => {},
        supportedCommands: async () => [],
        supportedModels: async () => [],
        getContextUsage: async () => ({ totalTokens: 10 }),
      } as unknown as Omit<ReturnType<QueryFn>, typeof Symbol.asyncIterator>,
    );
  };
  const input = (): AgentTurnInput => ({
    workspace: { id: 'w', name: 'fixture', dir: process.cwd() },
    sessionId: 'session',
    text: 'fixture',
    emit: () => {},
    requestPermission: async () => ({ allow: false }),
    requestInteraction: vi.fn(async () => ({ action: 'submit' as const, values: {} })),
    completeInteraction: vi.fn(),
  });
  const a = input(),
    b = input(),
    c = input();
  const runtime = new ClaudeRuntime({ ...a, queryFn });
  try {
    await runtime.run(a).done;
    await runtime.run(b).done;
    await options.onElicitation!(
      { serverName: 'fixture', mode: 'url', message: '授权', url: 'https://example.test', elicitationId: 'auth' },
      { requestId: 'operation', signal: new AbortController().signal },
    );
    expect(a.requestInteraction).not.toHaveBeenCalled();
    expect(b.requestInteraction).toHaveBeenCalledOnce();
    await runtime.run(c).done;
    expect(b.completeInteraction).toHaveBeenCalledOnce();
    expect(c.completeInteraction).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
  }
});
it('URL完成通知按原生会话和MCP服务身份确认，未知消息不吞掉', () => {
  const completeInteraction = vi.fn();
  const input = { completeInteraction } as unknown as AgentTurnInput;
  const message = {
    type: 'system',
    subtype: 'elicitation_complete',
    mcp_server_name: 'fixture',
    elicitation_id: 'auth',
    session_id: 'session',
  };
  expect(claudeElicitationCompleted(input, {}, { id: 'runtime' })).toBe(false);
  claudeElicitationCompleted(input, message, { id: 'runtime', sessionId: 'foreign' });
  expect(completeInteraction).not.toHaveBeenCalled();
  claudeElicitationCompleted(input, message, { id: 'runtime', sessionId: 'session' });
  expect(completeInteraction).toHaveBeenCalledWith('runtime', JSON.stringify(['fixture', 'auth']));
});
it('后台子代理审批保持创建轮归属，任务完成后的迟到批准仍拒绝', async () => {
  let options!: Options;
  let turn = 0;
  const queryFn: QueryFn = (params) => {
    options = params.options;
    return Object.assign(
      (async function* () {
        for await (const _ of params.prompt) {
          turn++;
          if (turn === 1)
            yield {
              type: 'system',
              subtype: 'task_started',
              session_id: 'session',
              task_id: 'child',
              task_type: 'local_agent',
              is_backgrounded: true,
            };
          if (turn === 3)
            yield {
              type: 'system',
              subtype: 'task_notification',
              session_id: 'session',
              task_id: 'child',
              status: 'completed',
            };
          yield { type: 'result', subtype: 'success' };
        }
      })(),
      {
        close: () => {},
        interrupt: async () => undefined,
        supportedCommands: async () => [],
        supportedModels: async () => [],
        getContextUsage: async () => {
          throw new Error('合成上下文不可用');
        },
      },
    );
  };
  const owner = vi
    .fn<NonNullable<AgentTurnInput['requestInteraction']>>()
    .mockResolvedValue({ action: 'submit', values: { allow: 'allow' } });
  const later = vi.fn<NonNullable<AgentTurnInput['requestInteraction']>>();
  const requestPermission = vi.fn(async () => ({ allow: false }));
  const input: AgentTurnInput = {
    workspace: { id: 'w', name: 'fixture', dir: process.cwd() },
    sessionId: 'session',
    text: '合成任务',
    emit: () => {},
    requestPermission,
    requestInteraction: owner,
  };
  const runtime = new ClaudeRuntime({ ...input, queryFn });
  const toolInput = { command: 'pwd' };
  const permit = () =>
    options.canUseTool!('Bash', toolInput, {
      signal: new AbortController().signal,
      toolUseID: 'tool',
      requestId: 'permission',
      agentID: 'child',
    });
  try {
    await runtime.run(input).done;
    await runtime.run({ ...input, requestInteraction: later }).done;
    expect(await permit()).toEqual({ behavior: 'allow', updatedInput: toolInput });
    expect(owner).toHaveBeenCalledOnce();
    expect(owner.mock.calls[0]?.[0]).toMatchObject({
      scope: { kind: 'session', id: 'session' },
      spec: { source: 'Claude · 子代理 child', fields: [{ label: 'pwd' }] },
    });
    let answer!: (value: Awaited<ReturnType<typeof owner>>) => void;
    owner.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const pending = permit();
    await runtime.run({ ...input, requestInteraction: later }).done;
    answer({ action: 'submit', values: { allow: 'allow' } });
    expect(await pending).toMatchObject({ behavior: 'deny' });
    expect(await permit()).toMatchObject({ behavior: 'deny' });
    expect(owner).toHaveBeenCalledTimes(2);
    expect(later).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
  }
});
it('原生问题的多选与自由回答交回工具，取消不授权执行', async () => {
  const requestInteraction = vi
    .fn<NonNullable<AgentTurnInput['requestInteraction']>>()
    .mockResolvedValueOnce({ action: 'submit', values: { q0: ['A', '自填'] } })
    .mockResolvedValueOnce({ action: 'cancel' });
  const input = { requestInteraction } as unknown as AgentTurnInput;
  const tool = { questions: [{ question: '功能', multiSelect: true, options: [{ label: 'A' }] }] };
  expect(await askClaudeQuestion(input, tool, context)).toMatchObject({
    behavior: 'allow',
    updatedInput: { answers: { 功能: 'A, 自填' } },
  });
  expect(await askClaudeQuestion(input, tool, context)).toMatchObject({ behavior: 'deny' });
  expect(requestInteraction.mock.calls[0]?.[1]?.signal).toBe(context.signal);
});
it('MCP回调保留服务器来源与无回合拥有者，拒绝不转换成空接受', async () => {
  const requestInteraction = vi
    .fn<NonNullable<AgentTurnInput['requestInteraction']>>()
    .mockResolvedValue({ action: 'decline' });
  const result = await claudeElicitation(
    { requestInteraction } as unknown as AgentTurnInput,
    {
      serverName: 'fixture',
      message: '资料',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
    { ...context, requestId: 'operation' },
  );
  expect(result).toEqual({ action: 'decline' });
  expect(requestInteraction).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: { kind: 'nativeOperation', id: 'operation' },
      spec: expect.objectContaining({ source: 'fixture' }),
    }),
    expect.anything(),
  );
});
