import { expect, it, vi } from 'vitest';
import type { AgentTurnInput } from '../../../src/agents/contracts';
import type { AcpConnection } from '../../../src/agents/antigravity/acp/types';
import { AcpInteractions } from '../../../src/agents/antigravity/acp/interactions';
it('未知表单取消而不放宽约束，URL完成通知核对会话并传递原生身份', async () => {
  const client = { respond: vi.fn(), reject: vi.fn() };
  const completeInteraction = vi.fn();
  const handler = new AcpInteractions(
    client as unknown as AcpConnection,
    { completeInteraction } as unknown as AgentTurnInput,
    () => 'session',
  );
  expect(handler.request({ id: 0, method: 'unknown', params: {} })).toBe(false);
  handler.request({
    id: 1,
    method: 'elicitation/create',
    params: {
      sessionId: 'session',
      mode: 'form',
      requestedSchema: { type: 'object', properties: { bad: { $ref: '#/other' } } },
    },
  });
  await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith(1, { action: 'cancel' }));
  handler.request({
    id: 2,
    method: 'elicitation/create',
    params: { sessionId: 'session', mode: 'url', url: 'https://example.test', elicitationId: 'auth' },
  });
  await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith(2, { action: 'cancel' }));
  handler.complete({ sessionId: 'other', elicitationId: 'auth' });
  handler.complete({});
  expect(completeInteraction).not.toHaveBeenCalled();
  handler.complete({ sessionId: 'session', elicitationId: 'auth' });
  expect(completeInteraction).toHaveBeenCalledWith(handler.runtimeId, 'auth');
  handler.close();
});
it('建会话前只接受已发原生操作的表单，陌生会话或请求不能跨归属', async () => {
  const client = { respond: vi.fn(), reject: vi.fn(), ownsRequest: (id: unknown) => id === 7 };
  const requestInteraction = vi
    .fn<NonNullable<AgentTurnInput['requestInteraction']>>()
    .mockResolvedValue({ action: 'submit', values: { f0: '1' } });
  const handler = new AcpInteractions(
    client as unknown as AcpConnection,
    { requestInteraction } as unknown as AgentTurnInput,
    () => undefined,
  );
  const params = {
    mode: 'form',
    message: '选择',
    requestedSchema: {
      type: 'object',
      properties: { native: { type: 'string', oneOf: [{ const: '1', title: '一' }] } },
    },
  };
  handler.request({ id: 'good', method: 'elicitation/create', params: { ...params, requestId: 7 } });
  handler.request({ id: 'bad', method: 'elicitation/create', params: { ...params, requestId: 8 } });
  handler.request({
    id: 'foreign',
    method: 'elicitation/create',
    params: { ...params, sessionId: 'other', requestId: 7 },
  });
  await vi.waitFor(() =>
    expect(client.respond).toHaveBeenCalledWith('good', { action: 'accept', content: { native: '1' } }),
  );
  expect(client.reject.mock.calls).toEqual([['bad'], ['foreign']]);
  expect(requestInteraction.mock.calls[0]?.[0].scope).toEqual({ kind: 'nativeOperation', id: '7' });
});
it('关闭ACP明确cancel等待中的表单，迟到答案不再发送', async () => {
  const client = { respond: vi.fn(), reject: vi.fn() };
  let answer!: (value: { action: 'submit'; values: Record<string, never> }) => void;
  const requestInteraction = vi.fn<NonNullable<AgentTurnInput['requestInteraction']>>(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const handler = new AcpInteractions(
    client as unknown as AcpConnection,
    { requestInteraction } as unknown as AgentTurnInput,
    () => 'session',
  );
  handler.request({
    id: 'form',
    method: 'elicitation/create',
    params: {
      sessionId: 'session',
      mode: 'form',
      message: '确认',
      requestedSchema: { type: 'object', properties: {} },
    },
  });
  handler.close();
  expect(requestInteraction.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  answer({ action: 'submit', values: {} });
  await Promise.resolve();
  expect(client.respond.mock.calls).toEqual([['form', { action: 'cancel' }]]);
});
