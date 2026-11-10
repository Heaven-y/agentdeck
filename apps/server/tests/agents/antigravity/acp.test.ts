import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agentdeck/shared/conversation';
import type { AgentTurnInput, TurnRunner } from '../../../src/agents/contracts';
import { createAntigravityAcpRunner } from '../../../src/agents/antigravity/acp/runtime';
import type { AcpConnection, AcpRecord, AcpRequest } from '../../../src/agents/antigravity/acp/types';
import { AntigravityAcpMapper } from '../../../src/agents/antigravity/acp/mapper';

const cwd = path.join(tmpdir(), 'agentdeck-acp-fixture');
const configuration = () => Promise.resolve({ modelProvider: 'gemini', model: 'gemini-test' });
const runners: TurnRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map(async (runner) => runner.dispose?.()));
});

function fakeClient() {
  let settleClose!: () => void;
  let settlePrompt: ((value: AcpRecord) => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    settleClose = resolve;
  });
  const options = [
    { id: 'model', currentValue: 'gemini-test', options: [{ value: 'gemini-test', name: 'Gemini Test' }] },
    {
      id: 'thought_level',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
  const client: AcpConnection = {
    closed,
    onNotification: () => {},
    onRequest: () => {},
    request: vi.fn(async (method, _params) => {
      if (method === 'initialize')
        return {
          protocolVersion: 1,
          agentInfo: { version: '1.5.3' },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { resume: {} },
            promptCapabilities: { image: true, embeddedContext: true },
          },
          authMethods: [{ id: 'gemini-api-key' }],
        };
      if (method === 'session/new' || method === 'session/resume')
        return { sessionId: 'native-1', configOptions: options };
      if (method === 'session/set_config_option') return { configOptions: options };
      if (method === 'session/prompt')
        return new Promise<AcpRecord>((resolve) => {
          settlePrompt = resolve;
        });
      return {};
    }),
    notify: vi.fn((method) => {
      if (method === 'session/cancel') settlePrompt?.({ stopReason: 'cancelled' });
    }),
    respond: vi.fn(),
    reject: vi.fn(),
    close: vi.fn(async () => {
      settlePrompt?.({ stopReason: 'cancelled' });
      settleClose();
    }),
  };
  return {
    client,
    finish: (value: AcpRecord = { stopReason: 'end_turn' }) => settlePrompt?.(value),
    update: (update: AcpRecord, sessionId = 'native-1') =>
      client.onNotification('session/update', { sessionId, update }),
  };
}

function setup(
  options: {
    settings?: () => Promise<AcpRecord>;
    input?: Partial<AgentTurnInput>;
    client?: ReturnType<typeof fakeClient>;
  } = {},
) {
  const native = options.client ?? fakeClient();
  const events: AgentEvent[] = [];
  const headless = vi.fn(() => ({ done: Promise.resolve(), interrupt: async () => {} })) as unknown as TurnRunner;
  const createClient = vi.fn(async () => native.client);
  const runner = createAntigravityAcpRunner({
    env: { GEMINI_API_KEY: 'synthetic' },
    createClient,
    settings: options.settings ?? configuration,
    headless,
  });
  runners.push(runner);
  const input: AgentTurnInput = {
    workspace: { id: 'p', name: '项目', dir: cwd },
    text: '测试输入',
    emit: (event) => events.push(event),
    requestPermission: async () => ({ allow: false }),
    ...options.input,
  };
  return { ...native, runner, events, headless, createClient, input, run: () => runner(input) };
}
async function started(client: AcpConnection) {
  await vi.waitFor(() =>
    expect(client.request).toHaveBeenCalledWith('session/prompt', expect.anything(), expect.anything()),
  );
}

describe('AGY ACP 对话与兼容路径', () => {
  it('使用真实客户端身份和API Key方式，验证选择后才投递；回合使用ACP结果独立统计', async () => {
    const f = setup();
    const handle = f.run();
    await started(f.client);
    expect(f.client.request).toHaveBeenCalledWith(
      'initialize',
      expect.objectContaining({
        clientInfo: expect.objectContaining({ name: 'agentdeck' }),
        clientCapabilities: expect.objectContaining({ terminal: false }),
      }),
      expect.anything(),
    );
    expect(f.client.request).toHaveBeenCalledWith('authenticate', { methodId: 'gemini-api-key' }, expect.anything());
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回答' } });
    f.finish({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } });
    await handle.done;
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: 'session', sessionId: 'native-1', model: 'gemini-test' }),
    );
    expect(f.events).toContainEqual({ type: 'text', delta: '回答' });
    expect(f.events.at(-1)).toMatchObject({
      type: 'turn_end',
      isError: false,
      usage: { inputTokens: 10, outputTokens: 4, scope: 'turn' },
    });
    expect(f.headless).not.toHaveBeenCalled();
  });

  it('已有会话使用resume保持原生ID，不重放旧消息作为新一轮输入', async () => {
    const f = setup({ input: { sessionId: 'native-1' } });
    const handle = f.run();
    await started(f.client);
    f.finish();
    await handle.done;
    expect(f.client.request).toHaveBeenCalledWith(
      'session/resume',
      expect.objectContaining({ sessionId: 'native-1', cwd }),
      expect.anything(),
    );
    expect(vi.mocked(f.client.request).mock.calls.filter(([method]) => method === 'session/new')).toHaveLength(0);
    expect(f.events.filter((e) => e.type === 'user_message')).toEqual([]);
  });

  it('自定义模型沿用headless，不在ACP选择另一个默认型号', async () => {
    const f = setup({
      settings: async () => ({
        modelProvider: 'gemini',
        model: 'custom',
        customModelsConfig: { customModels: { custom: { modelName: 'private-model', label: 'Custom' } } },
      }),
    });
    await f.run().done;
    expect(f.headless).toHaveBeenCalledOnce();
    expect(f.createClient).not.toHaveBeenCalled();
  });

  it('原生不支持选择时只在输入前兼容，不能提前绑定被放弃的ACP会话', async () => {
    const f = setup({ input: { model: 'unavailable-model' } });
    await f.run().done;
    expect(f.headless).toHaveBeenCalledOnce();
    expect(vi.mocked(f.client.request).mock.calls.some(([method]) => method === 'session/prompt')).toBe(false);
    expect(f.events.some((event) => event.type === 'session')).toBe(false);
    expect(f.client.close).toHaveBeenCalled();
  });

  it('prompt发送后错误不得切换协议重发，也不回显原生敏感错误', async () => {
    const native = fakeClient();
    const original = native.client.request;
    native.client.request = vi.fn(async (method, params, options) => {
      if (method === 'session/prompt') throw new Error('token=private https://private.invalid');
      return original(method, params, options);
    });
    const f = setup({ client: native });
    await f.run().done;
    expect(f.headless).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({ type: 'turn_end', isError: true });
    expect(JSON.stringify(f.events)).not.toMatch(/token=|private.invalid/);
  });

  it('原生返回不同会话ID时拒绝续接，不回退成另一个会话', async () => {
    const f = setup({ input: { sessionId: 'expected' } });
    await f.run().done;
    expect(f.headless).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({ type: 'turn_end', isError: true });
    expect(vi.mocked(f.client.request).mock.calls.some(([method]) => method === 'session/prompt')).toBe(false);
  });

  it('批准按原生optionId返回，取消后迟到批准无效', async () => {
    let answer!: (value: { allow: boolean }) => void;
    const f = setup({
      input: {
        requestPermission: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      },
    });
    const handle = f.run();
    await started(f.client);
    const request: AcpRequest = {
      id: 'rpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'native-1',
        toolCall: { toolCallId: 'tool-1', title: '测试命令', kind: 'execute', rawInput: { command: 'fixture' } },
        options: [
          { optionId: 'native-allow', kind: 'allow_once' },
          { optionId: 'native-deny', kind: 'reject_once' },
        ],
      },
    };
    f.client.onRequest(request);
    await vi.waitFor(() => expect(f.events.some((e) => e.type === 'permission_request')).toBe(true));
    await handle.interrupt();
    answer({ allow: true });
    await Promise.resolve();
    expect(f.client.respond).toHaveBeenCalledWith('rpc-1', { outcome: { outcome: 'cancelled' } });
    expect(vi.mocked(f.client.respond).mock.calls).toHaveLength(1);
    expect(f.events.at(-1)).toMatchObject({ type: 'turn_end', isError: true });
  });

  it.each([true, false])('原生批准选择%s只返回对应一次性选项，未知请求明确拒绝', async (allow) => {
    const f = setup({ input: { requestPermission: async () => ({ allow }) } });
    const handle = f.run();
    await started(f.client);
    f.client.onRequest({ id: 'unknown', method: 'fs/write_text_file', params: { path: 'arbitrary' } });
    expect(f.client.reject).toHaveBeenCalledWith('unknown');
    f.client.onRequest({
      id: 'approval',
      method: 'session/request_permission',
      params: {
        sessionId: 'native-1',
        toolCall: { name: 'run_command', rawInput: { command: 'fixture' } },
        options: [
          { optionId: 'once', kind: 'allow_once' },
          { optionId: 'always', kind: 'allow_always' },
          { optionId: 'no', kind: 'reject_once' },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(f.client.respond).toHaveBeenCalledWith('approval', {
        outcome: { outcome: 'selected', optionId: allow ? 'once' : 'no' },
      }),
    );
    f.finish();
    await handle.done;
  });

  it('准备阶段取消后不启动模型，不把取消改为headless重试', async () => {
    let ready!: (value: AcpRecord) => void;
    const f = setup({
      settings: () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    });
    const handle = f.run();
    const interrupted = handle.interrupt();
    ready({ modelProvider: 'gemini', model: 'gemini-test' });
    await interrupted;
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.headless).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({ type: 'turn_end', isError: true });
  });

  it('显式参数必须原生确认，未确认时不发送用户内容', async () => {
    const f = setup({ input: { reasoningEffort: 'high' } });
    await f.run().done;
    expect(f.client.request).toHaveBeenCalledWith(
      'session/set_config_option',
      { sessionId: 'native-1', configId: 'thought_level', value: 'high' },
      expect.anything(),
    );
    expect(f.headless).toHaveBeenCalledOnce();
    expect(vi.mocked(f.client.request).mock.calls.some(([method]) => method === 'session/prompt')).toBe(false);
  });

  it('拒绝不属于当前会话的通知并停止本轮，旧stderr不会叠加历史524', async () => {
    const f = setup();
    const handle = f.run();
    await started(f.client);
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '其他会话' } }, 'other');
    await handle.done;
    expect(f.events).not.toContainEqual({ type: 'text', delta: '其他会话' });
    expect(f.events.at(-1)).toMatchObject({ type: 'turn_end', isError: true });
  });
});

describe('ACP 原生事件投影', () => {
  it('完整计划标记完成，原生上下文窗口和工具差异保持原生范围', () => {
    const mapper = new AntigravityAcpMapper();
    expect(
      mapper.update({ sessionUpdate: 'plan', entries: [{ content: '验证完成', status: 'completed' }] }),
    ).toContainEqual(expect.objectContaining({ type: 'activity', status: 'completed' }));
    expect(mapper.update({ sessionUpdate: 'usage_update', used: 200, size: 1000 })).toEqual([
      { type: 'context', usage: { usedTokens: 200, windowTokens: 1000, source: 'antigravity_estimate' } },
    ]);
    expect(mapper.update({ sessionUpdate: 'usage_update', used: -1, size: 0 })).toEqual([]);
    mapper.update({ sessionUpdate: 'tool_call', toolCallId: 'edit', name: 'edit_file', status: 'in_progress' });
    expect(
      mapper.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path: 'fixture.txt', oldText: 'before', newText: 'after' }],
      }),
    ).toContainEqual(
      expect.objectContaining({ type: 'tool_result', isError: false, output: 'fixture.txt\nbefore\nafter' }),
    );
  });
  it('工具更新合并原生ID，明确终态才完成，不把工具失败当整轮失败', () => {
    const mapper = new AntigravityAcpMapper();
    expect(
      mapper.update({
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        title: '读取',
        status: 'pending',
        kind: 'read',
        rawInput: { path: 'file.txt' },
      }),
    ).toEqual([expect.objectContaining({ type: 'tool_call', id: 't' })]);
    expect(
      mapper
        .update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress' })
        .some((e) => e.type === 'tool_result'),
    ).toBe(false);
    expect(
      mapper.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: '无法读取' } }],
      }),
    ).toContainEqual(expect.objectContaining({ type: 'tool_result', id: 't', isError: true, output: '无法读取' }));
    expect(mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed' })).toEqual([]);
  });
  it('公开思考与计划映射，用户回放与未知私有字段不混入新回复', () => {
    const mapper = new AntigravityAcpMapper();
    expect(
      mapper.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '公开推理' } }),
    ).toEqual([{ type: 'reasoning', delta: '公开推理' }]);
    expect(
      mapper.update({ sessionUpdate: 'plan', entries: [{ content: '验证', status: 'in_progress', priority: 'high' }] }),
    ).toContainEqual(expect.objectContaining({ type: 'activity', name: '计划' }));
    expect(mapper.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '历史' } })).toEqual([]);
    expect(mapper.update({ sessionUpdate: 'private', signature: 'hidden' })).toEqual([]);
  });
});
