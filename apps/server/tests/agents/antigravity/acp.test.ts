import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agentdeck/shared/conversation';
import type { AgentTurnInput, TurnRunner } from '../../../src/agents/contracts';
import { createAntigravityAcpRunner } from '../../../src/agents/antigravity/acp/runtime';
import { AcpError } from '../../../src/agents/antigravity/acp/types';
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
  let failPrompt: ((error: Error) => void) | undefined;
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
        return new Promise<AcpRecord>((resolve, reject) => {
          settlePrompt = resolve;
          failPrompt = reject;
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
    failPrompt: (error: Error) => failPrompt?.(error),
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
  it('已有会话专用命令等待迟到的真实目录，压缩完成有状态，不重放历史或转入headless', async () => {
    const f = setup({
      input: { sessionId: 'native-1', text: '', invocation: { kind: 'acp-command', name: 'compact' } },
    });
    const handle = f.run();
    await vi.waitFor(() =>
      expect(f.client.request).toHaveBeenCalledWith('session/resume', expect.anything(), expect.anything()),
    );
    expect(vi.mocked(f.client.request).mock.calls.some(([method]) => method === 'session/prompt')).toBe(false);
    f.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] });
    await started(f.client);
    expect(f.client.request).toHaveBeenCalledWith(
      'session/prompt',
      { sessionId: 'native-1', prompt: [{ type: 'text', text: '/compact' }] },
      expect.anything(),
    );
    expect(handle.canSteer?.()).toBe(false);
    f.finish();
    await handle.done;
    expect(f.events.filter((event) => event.type === 'compaction')).toEqual([
      { type: 'compaction', state: { status: 'running', trigger: 'manual' } },
      { type: 'compaction', state: { status: 'completed', trigger: 'manual' } },
    ]);
    expect(f.headless).not.toHaveBeenCalled();
  });
  it('ACP专用命令不能降级为兼容模式提示词，等待目录时取消不发送', async () => {
    const f = setup({
      input: {
        text: '',
        permission: { agent: 'antigravity', mode: 'auto' },
        invocation: { kind: 'acp-command', name: 'compact' },
      },
    });
    await f.run().done;
    expect(f.headless).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({ isError: true });
    const pending = setup({ input: { text: '', invocation: { kind: 'acp-command', name: 'compact' } } });
    const handle = pending.run();
    await vi.waitFor(() =>
      expect(pending.client.request).toHaveBeenCalledWith('session/new', expect.anything(), expect.anything()),
    );
    await handle.interrupt();
    expect(vi.mocked(pending.client.request).mock.calls.some(([method]) => method === 'session/prompt')).toBe(false);
  });
  it('原生prompt完成后等待图片保存期间已不可再引导，避免另起隐藏prompt', async () => {
    let release!: () => void;
    const stored = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const f = setup({
      input: {
        attachments: [
          {
            id: 'image',
            revision: 'a'.repeat(64),
            name: 'fixture.png',
            kind: 'image',
            mimeType: 'image/png',
            size: 1,
            data: Buffer.from('x'),
            path: path.join(cwd, 'fixture.png'),
          },
        ],
        attachmentsStored: stored,
      },
    });
    const handle = f.run();
    await started(f.client);
    f.finish();
    await vi.waitFor(() => expect(stored).toHaveBeenCalledOnce());
    try {
      expect(handle.canSteer?.()).toBe(false);
      expect((await handle.steer!({ clientMessageId: 'late', text: 'late' })).status).toBe('rejected');
    } finally {
      release();
      await handle.done;
    }
  });
  it('多次引导转移完成门，旧prompt提前end_turn不能结束新请求；取消最新请求才结束', async () => {
    const f = setup({ input: { clientMessageId: 'initial' } });
    const native = vi.mocked(f.client.request).getMockImplementation()!;
    const prompts: Array<{ resolve(value: AcpRecord): void }> = [];
    vi.mocked(f.client.request).mockImplementation(async (method, params, options) => {
      if (method !== 'session/prompt') return native(method, params, options);
      prompts.at(-1)?.resolve({ stopReason: 'end_turn' });
      return new Promise((resolve) => {
        prompts.push({ resolve });
      });
    });
    vi.mocked(f.client.notify).mockImplementation((method) => {
      if (method === 'session/cancel') prompts.at(-1)?.resolve({ stopReason: 'cancelled' });
    });
    const handle = f.run();
    await started(f.client);
    for (const text of ['guide-one', 'guide-two']) {
      const count = prompts.length;
      let accepted = 0;
      const pending = handle.steer!({
        clientMessageId: text,
        text,
        onAccepted: () => {
          accepted++;
        },
      });
      await vi.waitFor(() => expect(prompts).toHaveLength(count + 1));
      f.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
      expect((await pending).status).toBe('accepted');
      expect(accepted).toBe(1);
      expect(f.events.some((event) => event.type === 'turn_end')).toBe(false);
    }
    await handle.interrupt();
    await handle.done;
    expect(f.events.filter((event) => event.type === 'turn_end')).toEqual([{ type: 'turn_end', isError: true }]);
    expect((await handle.steer!({ clientMessageId: 'late', text: 'late' })).status).toBe('rejected');
  });
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

describe('AGY 原生服务临时故障', () => {
  const timeout = new AcpError(
    'native',
    'Antigravity 的模型服务响应超时（HTTP 524），本轮未完成。请稍后重试或检查原生模型服务。',
    true,
  );
  it('本轮已产出正文时只留一条可折叠记录，不标记失败', async () => {
    const f = setup();
    const handle = f.run();
    await started(f.client);
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已生成的正文' } });
    f.failPrompt(timeout);
    await handle.done;
    expect(f.events.filter((event) => event.type === 'error')).toEqual([]);
    expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: false });
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: 'activity', id: 'agy-service-retry', status: 'completed' }),
    );
  });

  it('没有任何正文时仍作为错误上报并标记失败', async () => {
    const f = setup();
    const handle = f.run();
    await started(f.client);
    f.failPrompt(timeout);
    await handle.done;
    expect(f.events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  });

  it('不可重试的原生错误即使已产出正文仍然报错', async () => {
    const f = setup();
    const handle = f.run();
    await started(f.client);
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已生成的正文' } });
    f.failPrompt(new AcpError('native', 'Antigravity 认证失败或凭据无效，请检查原生登录状态与当前模型服务的凭据。'));
    await handle.done;
    expect(f.events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  });

  it('不同轮次的超时记录各自独立，不会合并到上一轮', async () => {
    const ids = await Promise.all(
      ['turn-a', 'turn-b'].map(async (clientMessageId) => {
        const f = setup({ input: { clientMessageId } });
        const handle = f.run();
        await started(f.client);
        f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正文' } });
        f.failPrompt(timeout);
        await handle.done;
        return f.events.find((event) => event.type === 'activity')?.id;
      }),
    );
    expect(ids[0]).toContain('turn-a');
    expect(ids[1]).toContain('turn-b');
    expect(new Set(ids).size).toBe(2);
  });
});
