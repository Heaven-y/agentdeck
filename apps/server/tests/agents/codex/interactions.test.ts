import { expect, it, vi } from 'vitest';
import type { AgentTurnInput } from '../../../src/agents/contracts';
import type { CodexClient } from '../../../src/agents/codex/client';
import { CodexInteractions } from '../../../src/agents/codex/interactions';
it('停止回合取消阻塞问题，非阻塞问题保留到原生撤销或实例关闭，不重复展示同一RPC', async () => {
  const client = { respond: vi.fn(), rejectRequest: vi.fn() };
  const requestInteraction = vi.fn<NonNullable<AgentTurnInput['requestInteraction']>>(() => new Promise(() => {}));
  const handler = new CodexInteractions(client as unknown as CodexClient, () => ({
    input: { requestInteraction } as unknown as AgentTurnInput,
    sessionId: 'thread',
    matchesTurn: () => true,
  }));
  const params = {
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'item',
    questions: [{ id: 'q', question: '回答', options: null }],
  };
  const request = { id: 'blocking', method: 'item/tool/requestUserInput', params };
  expect(handler.request({ id: 9, method: 'unknown', params: {} })).toBe(false);
  handler.request(request);
  handler.request(request);
  handler.request({ ...request, id: 'nonblocking', params: { ...params, isBlocking: false } });
  expect(requestInteraction).toHaveBeenCalledTimes(2);
  handler.cancelTurn('turn');
  expect(client.rejectRequest.mock.calls).toEqual([['blocking']]);
  expect(requestInteraction.mock.calls[1]?.[0].scope).toEqual({ kind: 'session', id: 'thread' });
  handler.close();
  expect(client.rejectRequest.mock.calls).toEqual([['blocking'], ['nonblocking']]);
  handler.resolved(undefined);
  const fallback = new CodexInteractions(client as unknown as CodexClient, () => ({
    input: {} as AgentTurnInput,
    sessionId: 'thread',
    matchesTurn: () => true,
  }));
  fallback.request({ ...request, id: 'absent' });
  await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith('absent', { answers: {} }));
  fallback.request({ ...request, id: 'malformed', params: { ...params, questions: [] } });
  await vi.waitFor(() => expect(client.rejectRequest).toHaveBeenCalledWith('malformed'));
  fallback.request({ ...request, id: 'missing-item', params: { ...params, itemId: null } });
  expect(client.rejectRequest).toHaveBeenCalledWith('missing-item');
});
it('问题答复保留原生ID，其他线程和旧轮次不能借用当前回答入口', async () => {
  const client = { respond: vi.fn(), rejectRequest: vi.fn() };
  const requestInteraction = vi
    .fn<NonNullable<AgentTurnInput['requestInteraction']>>()
    .mockResolvedValue({ action: 'submit', values: { q0: 'A' } });
  const handler = new CodexInteractions(client as unknown as CodexClient, () => ({
    input: { requestInteraction } as unknown as AgentTurnInput,
    sessionId: 'thread',
    matchesTurn: (id) => id === 'turn',
  }));
  const params = {
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'item',
    questions: [{ id: 'native', question: '选择', options: [{ label: 'A' }] }],
  };
  handler.request({ id: 1, method: 'item/tool/requestUserInput', params });
  handler.request({ id: 2, method: 'item/tool/requestUserInput', params: { ...params, threadId: 'foreign' } });
  handler.request({ id: 3, method: 'item/tool/requestUserInput', params: { ...params, turnId: 'old' } });
  await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith(1, { answers: { native: { answers: ['A'] } } }));
  expect(requestInteraction).toHaveBeenCalledTimes(1);
  expect(client.rejectRequest.mock.calls).toEqual([[2], [3]]);
});
it('会话MCP请求不随旧turn取消，原生resolved后迟到答复无效', async () => {
  const client = { respond: vi.fn(), rejectRequest: vi.fn() };
  let answer!: (value: { action: 'cancel' }) => void;
  const requestInteraction = vi.fn<NonNullable<AgentTurnInput['requestInteraction']>>(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const handler = new CodexInteractions(client as unknown as CodexClient, () => ({
    input: { requestInteraction } as unknown as AgentTurnInput,
    sessionId: 'thread',
    matchesTurn: () => false,
  }));
  handler.request({
    id: 'form',
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread',
      turnId: null,
      mode: 'form',
      message: '资料',
      requestedSchema: { type: 'object', properties: {} },
    },
  });
  handler.cancelTurn('old');
  expect(client.rejectRequest).not.toHaveBeenCalled();
  expect(requestInteraction.mock.calls[0]?.[0].scope).toEqual({ kind: 'session', id: 'thread' });
  handler.resolved('form');
  expect(requestInteraction.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  answer({ action: 'cancel' });
  await Promise.resolve();
  expect(client.respond).not.toHaveBeenCalled();
});
