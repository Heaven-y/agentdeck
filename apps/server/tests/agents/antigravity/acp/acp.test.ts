import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ServerMessage } from '@agentdeck/shared/conversation';
import { TurnManager, type Socket } from '../../../../src/chat/turn-manager';
import type { AgentTurnInput, TurnRunner } from '../../../../src/agents/contracts';
import { createAntigravityAcpRunner } from '../../../../src/agents/antigravity/acp/runtime';
import { AcpError } from '../../../../src/agents/antigravity/acp/types';
import type { AcpConnection, AcpRecord, AcpRequest } from '../../../../src/agents/antigravity/acp/types';
import { AntigravityAcpMapper } from '../../../../src/agents/antigravity/acp/mapper';
import type { NativeContextWindow } from '@agentdeck/shared/settings';
import {
  antigravityContextWindow,
  antigravityContextWindowSnapshot,
} from '../../../../src/agents/antigravity/models/context-window';

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
    readAccount?: () => Promise<{ email?: string }>;
    input?: Partial<AgentTurnInput>;
    client?: ReturnType<typeof fakeClient>;
    contextWindow?: (settings: AcpRecord, model?: string) => Promise<NativeContextWindow>;
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
    readAccount: options.readAccount,
    contextWindow: options.contextWindow ?? (async (_settings, model) => ({ model, windowTokens: 1048576 })),
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
  it.each([
    { model: { invalid: true } },
    { model: 'gemini-test', customModelsConfig: { customModels: { broken: null } } },
  ])('原生模型配置形状错误时在选路前停止，不回退到默认模型：%j', async (invalid) => {
    const f = setup({ settings: async () => ({ modelProvider: 'gemini', ...invalid }) });
    const handle = f.run();
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({ type: 'error', message: expect.stringContaining('配置格式错误') }),
    );
    await handle.done;
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.headless).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
  });

  it('启动时按ACP确认的模型发布窗口快照，恢复和后台轮次不依赖界面缓存', async () => {
    const f = setup({
      settings: async () => ({ modelProvider: 'gemini', model: 'Gemini Test' }),
      contextWindow: async (_settings, model) => ({
        model,
        windowTokens: model === 'gemini-test' ? 1048576 : 200000,
      }),
    });
    const handle = f.run();
    await started(f.client);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: 'session',
        model: 'gemini-test',
        contextWindow: { model: 'gemini-test', windowTokens: 1048576 },
      }),
    );
    f.finish();
    await handle.done;
  });

  it('ACP 已确认的内置型号窗口不套用未选中的同底层型号自定义别名', async () => {
    const f = setup({
      settings: async () => ({
        modelProvider: 'gemini',
        model: 'Gemini Test',
        customModelsConfig: {
          customModels: {
            custom: { modelName: 'gemini-test', label: 'Custom', maxTokens: 200000 },
          },
        },
      }),
      contextWindow: (settings, model) =>
        antigravityContextWindowSnapshot(settings, model, (current, requested) =>
          antigravityContextWindow(current, requested, async () => ({
            models: {
              'gemini-test': { displayName: 'Gemini Test', maxTokens: 1048576 },
            },
          })),
        ),
    });
    const handle = f.run();
    await started(f.client);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: 'session',
        model: 'gemini-test',
        contextWindow: {
          model: 'gemini-test',
          windowTokens: 1048576,
        },
      }),
    );
    expect(f.headless).not.toHaveBeenCalled();
    f.finish();
    await handle.done;
  });

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

const image = {
  id: 'image-proof',
  revision: 'revision',
  name: 'test.png',
  kind: 'image' as const,
  mimeType: 'image/png',
  size: 3,
  path: path.join(cwd, 'test.png'),
  data: Buffer.from([1, 2, 3]),
};

function accountClient() {
  const f = fakeClient();
  const request = f.client.request.bind(f.client);
  const configOptions = [
    {
      id: 'model',
      currentValue: 'gemini-4-neon',
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      ],
    },
    { id: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
    {
      id: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
  f.client.request = vi.fn(async (method, params, callOptions) => {
    if (method === 'initialize')
      return {
        ...(await request(method, params, callOptions)),
        authMethods: [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }],
      };
    if (method === 'session/new' || method === 'session/resume')
      return { ...(method === 'session/new' ? { sessionId: 'native-1' } : {}), configOptions };
    if (method === 'session/set_config_option') {
      configOptions.find((option) => option.id === params.configId)!.currentValue = String(params.value);
      if (params.configId === 'model') configOptions[1]!.options.push({ value: 'low', name: 'Low' });
      return { configOptions };
    }
    return request(method, params, callOptions);
  });
  return f;
}

describe('AGY 官方账号图片', () => {
  const settings = async () => ({ model: 'Gemini 4 Argon (Low)' });
  const readAccount = async () => ({ email: 'fixture@example.invalid' });

  it.each([undefined, 'native-1'])('复用登录，按原生选项发图且不重放历史：%s', async (sessionId) => {
    const attachmentsStored = vi.fn(async () => {});
    const f = setup({
      settings,
      readAccount,
      client: accountClient(),
      input: {
        sessionId,
        attachments: [image],
        attachmentsStored,
        reasoningEffort: 'high',
        permission: { agent: 'antigravity', mode: 'plan' },
      },
    });
    const turn = f.run();
    await started(f.client);
    expect(f.createClient.mock.calls).toEqual([
      [expect.objectContaining({ env: expect.not.objectContaining({ GEMINI_API_KEY: expect.anything() }) })],
    ]);
    expect(f.client.request).toHaveBeenCalledWith('authenticate', { methodId: 'oauth-personal' }, expect.anything());
    expect(f.client.request).toHaveBeenCalledWith(
      sessionId ? 'session/resume' : 'session/new',
      { cwd, mcpServers: [], ...(sessionId ? { sessionId } : {}) },
      expect.anything(),
    );
    expect(f.client.request).not.toHaveBeenCalledWith('session/load', expect.anything(), expect.anything());
    expect(f.client.request).toHaveBeenCalledWith(
      'session/prompt',
      {
        sessionId: 'native-1',
        prompt: [
          { type: 'text', text: f.input.text },
          { type: 'image', mimeType: image.mimeType, data: image.data.toString('base64') },
        ],
      },
      expect.anything(),
    );
    const applied = vi.mocked(f.client.request).mock.calls.filter(([method]) => method === 'session/set_config_option');
    expect(applied.map(([, p]) => [p.configId, p.value])).toEqual([
      ['model', 'gemini-4-argon'],
      ['thought_level', 'low'],
      ['mode', 'plan'],
    ]);
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: 'session', sessionId: 'native-1', model: 'gemini-4-argon-low' }),
    );
    expect(f.headless).not.toHaveBeenCalled();
    f.finish();
    await turn.done;
    expect(attachmentsStored).toHaveBeenCalledWith([image.id]);
  });

  it('已发图但本轮失败时保留正文，不标记成功或换协议重发', async () => {
    const attachmentsStored = vi.fn(async () => {});
    const f = setup({
      settings,
      readAccount,
      client: accountClient(),
      input: { attachments: [image], attachmentsStored },
    });
    const turn = f.run();
    await started(f.client);
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已收到的正文' } });
    f.failPrompt(new AcpError('native', 'AGY 模型服务超时。'));
    await turn.done;
    expect(f.events).toContainEqual({ type: 'text', delta: '已收到的正文' });
    expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
    expect(f.headless).not.toHaveBeenCalled();
    expect(attachmentsStored).not.toHaveBeenCalled();
    expect(vi.mocked(f.client.request).mock.calls.filter(([method]) => method === 'session/prompt')).toHaveLength(1);
  });

  it('账号文字续聊不探测登录、不打开 ACP', async () => {
    const probe = vi.fn(readAccount);
    const f = setup({ settings, readAccount: probe, input: { sessionId: 'native-1' } });
    await f.run().done;
    expect(f.headless).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'native-1', text: f.input.text }));
    expect(probe).not.toHaveBeenCalled();
    expect(f.createClient).not.toHaveBeenCalled();
  });

  it.each(['无登录', '自动权限', '会话不匹配'])('%s时保留图片且不改用文字发送', async (cause) => {
    const f = setup({
      settings,
      client: accountClient(),
      readAccount: cause === '无登录' ? async () => ({}) : readAccount,
      input: {
        attachments: [image],
        ...(cause === '自动权限' ? { permission: { agent: 'antigravity', mode: 'auto' } } : {}),
        ...(cause === '会话不匹配' ? { sessionId: 'native-origin' } : {}),
      },
    });
    if (cause === '会话不匹配') {
      const request = f.client.request.bind(f.client);
      f.client.request = vi.fn((method, params, options) =>
        method === 'session/resume'
          ? Promise.resolve({ sessionId: 'other-session' })
          : request(method, params, options),
      );
    }
    await f.run().done;
    expect(f.headless).not.toHaveBeenCalled();
    expect(f.client.request).not.toHaveBeenCalledWith('session/prompt', expect.anything(), expect.anything());
    expect(f.events.some((e) => e.type === 'session')).toBe(false);
    expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
    if (cause === '无登录' || cause === '自动权限') expect(f.createClient).not.toHaveBeenCalled();
  });
});

describe('AGY 原生服务临时故障', () => {
  const timeout = new AcpError(
    'native',
    'Antigravity 的模型服务响应超时（HTTP 524），本轮未完成。请稍后重试或检查原生模型服务。',
  );
  it('当前请求在输出正文后失败仍保留正文和失败终态，不换通道重发', async () => {
    const f = setup();
    const handle = f.run();
    await started(f.client);
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已生成的正文' } });
    f.failPrompt(timeout);
    await handle.done;
    expect(f.events).toContainEqual({ type: 'text', delta: '已生成的正文' });
    expect(f.events.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: timeout.message }]);
    expect(f.events.at(-1)).toEqual({ type: 'turn_end', isError: true });
    expect(f.headless).not.toHaveBeenCalled();
    expect(vi.mocked(f.client.request).mock.calls.filter(([method]) => method === 'session/prompt')).toHaveLength(1);
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

  it('ACP 部分正文后的服务失败通过真实宿主暂停待发，不启动下一轮', async () => {
    const f = setup();
    const messages: ServerMessage[] = [];
    const socket: Socket = { send: (message) => messages.push(message), isOpen: () => true };
    const manager = new TurnManager({
      getWorkspace: async () => f.input.workspace,
      sessions: { assertBelongs: async () => {} },
      runners: { antigravity: f.runner },
    });
    try {
      await manager.handle(socket, {
        type: 'chat.send',
        workspaceId: 'p',
        agent: 'antigravity',
        sessionId: 'native-1',
        text: '第一轮',
        clientTurnId: 'first-turn',
      });
      await started(f.client);
      const queueId = messages.find((message) => message.type === 'turn.started')!.queueId!;
      await manager.handle(socket, {
        type: 'chat.followup',
        queueId,
        clientMessageId: 'next-input',
        mode: 'queue',
        content: { text: '待发输入' },
      });
      f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '部分正文' } });
      f.failPrompt(timeout);
      await vi.waitFor(() => expect(messages.some((message) => message.type === 'turn.finished')).toBe(true));
      expect(manager.followups.snapshots(socket)[0]).toMatchObject({
        paused: true,
        items: [{ status: 'queued' }],
      });
      expect(vi.mocked(f.client.request).mock.calls.filter(([method]) => method === 'session/prompt')).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });
});
