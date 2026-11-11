import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentTurnInput, NativeInteractionRequest } from '../../../src/agents/contracts';
import type { InteractionAnswer } from '@agentdeck/shared/conversation';
import { CodexChildRequests } from '../../../src/agents/codex/child-requests';

it('子线程请求等待归属核验并返回原生RPC，父回合结束后仍用原会话拥有者，重复及跨线程拒绝', async () => {
  let resolve!: (value: InteractionAnswer) => void;
  const requestInteraction = vi.fn(
    (_request: NativeInteractionRequest) =>
      new Promise<InteractionAnswer>((r) => {
        resolve = r;
      }),
  );
  const input: AgentTurnInput = {
    workspace: { id: 'project', name: 'Fixture', dir: path.resolve('fixture') },
    text: '',
    emit: vi.fn(),
    requestPermission: async () => ({ allow: false }),
    requestInteraction,
  };
  const client = { respond: vi.fn(), rejectRequest: vi.fn() };
  const tasks = { settled: async () => {}, owns: (id: string, turnId?: string) => id === 'child' && turnId === 'turn' };
  const requests = new CodexChildRequests({ client, tasks, runtimeId: 'runtime', sessionId: () => 'root' });
  requests.remember('child', input);
  const req = {
    id: 'rpc',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'child', turnId: 'turn', command: 'fixture' },
  };
  requests.request(req);
  requests.request(req);
  await vi.waitFor(() => expect(requestInteraction).toHaveBeenCalledOnce());
  expect(requestInteraction.mock.calls[0]![0]).toMatchObject({
    scope: { kind: 'session', id: 'root' },
    spec: { blocking: true },
  });
  resolve({ action: 'submit', values: { allow: 'allow' } });
  await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith('rpc', { decision: 'accept' }));
  requests.request({ ...req, id: 'foreign', params: { threadId: 'other', turnId: 'turn' } });
  await vi.waitFor(() => expect(client.rejectRequest).toHaveBeenCalledWith('foreign'));
  requests.close();
});
it('原生子轮结束撤销问题，迟到网页答复无效；未经核验不能从请求自行注册新子代理', async () => {
  let signal: AbortSignal | undefined, resolve!: (value: InteractionAnswer) => void;
  const input: AgentTurnInput = {
    workspace: { id: 'project', name: 'Fixture', dir: path.resolve('fixture') },
    text: '',
    emit: vi.fn(),
    requestPermission: async () => ({ allow: false }),
    requestInteraction: (_request, options) => {
      signal = options?.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const client = { respond: vi.fn(), rejectRequest: vi.fn() };
  const requests = new CodexChildRequests({
    client,
    tasks: { settled: async () => {}, owns: () => true },
    runtimeId: 'runtime',
    sessionId: () => 'root',
  });
  requests.remember('child', input);
  requests.request({
    id: 'rpc',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'child', turnId: 'turn', command: 'fixture' },
  });
  await vi.waitFor(() => expect(signal).toBeDefined());
  requests.notify('turn/completed', { threadId: 'child', turn: { id: 'turn' } });
  expect(signal?.aborted).toBe(true);
  resolve({ action: 'submit', values: { allow: 'allow' } });
  await Promise.resolve();
  expect(client.respond).toHaveBeenCalledWith('rpc', { decision: 'cancel' });
  requests.request({
    id: 'unknown',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'unknown', turnId: 'turn' },
  });
  await vi.waitFor(() => expect(client.rejectRequest).toHaveBeenCalledWith('unknown'));
  requests.close();
});
it('核验后的子线程结构化问题/表单保留原生答案，未知方法拒绝，原生resolved仅撤销不重复答复', async () => {
  const answer = vi.fn(async (): Promise<InteractionAnswer> => ({ action: 'submit', values: { q0: 'A', f0: 'A' } }));
  const input: AgentTurnInput = {
    workspace: { id: 'project', name: 'Fixture', dir: path.resolve('fixture') },
    text: '',
    emit: vi.fn(),
    requestPermission: async () => ({ allow: false }),
    requestInteraction: answer,
  };
  const client = { respond: vi.fn(), rejectRequest: vi.fn() };
  const requests = new CodexChildRequests({
    client,
    tasks: { settled: async () => {}, owns: () => true },
    runtimeId: 'runtime',
    sessionId: () => 'root',
  });
  requests.remember('child', input);
  requests.request({
    id: 'q',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'child',
      turnId: 'turn',
      itemId: 'q',
      questions: [
        {
          id: 'q',
          header: 'Scope',
          question: '范围',
          options: [
            { label: 'A', description: 'First' },
            { label: 'B', description: 'Second' },
          ],
        },
      ],
    },
  });
  await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith('q', { answers: { q: { answers: ['A'] } } }));
  requests.request({
    id: 'form',
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'child',
      turnId: 'turn',
      serverName: 'fixture',
      mode: 'form',
      message: 'Form',
      requestedSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
  });
  await vi.waitFor(() =>
    expect(client.respond).toHaveBeenCalledWith('form', expect.objectContaining({ action: 'accept' })),
  );
  requests.request({ id: 'bad', method: 'unknown', params: { threadId: 'child', turnId: 'turn' } });
  await vi.waitFor(() => expect(client.rejectRequest).toHaveBeenCalledWith('bad'));
  expect(requests.request({ id: 'parent', method: 'unknown', params: { threadId: 'root' } })).toBe(false);
  answer.mockImplementation(() => new Promise(() => {}));
  requests.request({
    id: 'resolved',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'child', turnId: 'turn' },
  });
  await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(3));
  requests.notify('serverRequest/resolved', { requestId: 'resolved' });
  expect(client.respond).not.toHaveBeenCalledWith('resolved', expect.anything());
  requests.close();
  requests.request({ id: 'late', method: 'unknown', params: { threadId: 'child' } });
  expect(client.rejectRequest).toHaveBeenCalledWith('late');
});
it('权限请求表单明确呈现Codex实际授予的网络与文件系统范围', async () => {
  const answer = vi.fn(async (_request: NativeInteractionRequest) => ({
    action: 'submit' as const,
    values: { allow: 'allow' },
  }));
  const input: AgentTurnInput = {
    workspace: { id: 'project', name: 'Fixture', dir: path.resolve('fixture') },
    text: '',
    emit: vi.fn(),
    requestPermission: async () => ({ allow: false }),
    requestInteraction: answer,
  };
  const client = { respond: vi.fn(), rejectRequest: vi.fn() };
  const requests = new CodexChildRequests({
    client,
    tasks: { settled: async () => {}, owns: () => true },
    runtimeId: 'runtime',
    sessionId: () => 'root',
  });
  requests.remember('child', input);
  requests.request({
    id: 'permission',
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'child',
      turnId: 'turn',
      permissions: { network: { enabled: true }, fileSystem: { read: ['~/project/src'], write: ['~/project/out'] } },
    },
  });
  await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
  const spec = answer.mock.calls[0]![0].spec;
  expect(spec.kind).toBe('form');
  if (spec.kind !== 'form') throw new Error('expected approval form');
  expect(spec.fields[0]!.label).toContain('网络访问');
  expect(spec.fields[0]!.label).toContain('~/project/src');
  expect(spec.fields[0]!.label).toContain('~/project/out');
  expect(client.respond).toHaveBeenCalledWith('permission', {
    permissions: { network: { enabled: true }, fileSystem: { read: ['~/project/src'], write: ['~/project/out'] } },
    scope: 'turn',
  });
  requests.request({
    id: 'truncated-permission',
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'child',
      turnId: 'turn',
      permissions: {
        fileSystem: {
          read: [
            ...Array.from({ length: 5 }, (_, index) => `~/project/read-${index}`),
            `${'x'.repeat(130)}`,
            '~/hidden',
          ],
        },
      },
    },
  });
  await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
  const longSpec = answer.mock.calls[1]![0].spec;
  if (longSpec.kind !== 'form') throw new Error('expected approval form');
  expect(longSpec.fields[0]!.label).toContain('路径已截断');
  expect(longSpec.fields[0]!.label).toContain('另有 1 条路径未显示');
  expect(longSpec.fields[0]!.label.length).toBeLessThanOrEqual(2000);
  requests.request({
    id: 'maximum-permission',
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'child',
      turnId: 'turn',
      command: 'c'.repeat(5000),
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: Array.from({ length: 50 }, (_, index) => `~/read-${index}/${'r'.repeat(500)}`),
          write: Array.from({ length: 50 }, (_, index) => `~/write-${index}/${'w'.repeat(500)}`),
        },
      },
    },
  });
  await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(3));
  const boundedSpec = answer.mock.calls[2]![0].spec;
  if (boundedSpec.kind !== 'form') throw new Error('expected approval form');
  expect(boundedSpec.fields[0]!.label).toContain('请求说明已截断');
  expect(boundedSpec.fields[0]!.label).toContain('文件读取');
  expect(boundedSpec.fields[0]!.label).toContain('文件写入');
  expect(boundedSpec.fields[0]!.label).toContain('另有 44 条路径未显示');
  expect(boundedSpec.fields[0]!.label.length).toBeLessThanOrEqual(2000);
  requests.close();
});
