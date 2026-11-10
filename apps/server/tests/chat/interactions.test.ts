import { afterEach, expect, it, vi } from 'vitest';
import type { InteractionSpec, InteractionEvent } from '@agentdeck/shared/conversation';
import { InteractionHub } from '../../src/chat/interactions';

afterEach(() => vi.useRealTimers());
it('URL已提交但运行实例结束时也要发出取消终态', async () => {
  const hub = new InteractionHub();
  const channel = {};
  const events: InteractionEvent[] = [];
  const abort = new AbortController();
  const result = hub.request(
    { channel, owner: { kind: 'session', id: 's', runtimeId: 'r' }, completionId: 'auth', emit: (e) => events.push(e) },
    { kind: 'url', title: '授权', url: 'https://example.test', blocking: true },
    { signal: abort.signal },
  );
  const first = events[0];
  if (first?.type !== 'interaction_request') throw new Error('没有请求');
  hub.respond(channel, first.interaction.id, { action: 'submit', values: {} });
  await result;
  abort.abort();
  expect(events.at(-1)).toMatchObject({ type: 'interaction_resolved', resolution: 'cancelled' });
});
it('连接与宿主请求预算有界，关闭拥有者释放等待，畸形或已中断请求不入队', async () => {
  const hub = new InteractionHub();
  const channels = Array.from({ length: 4 }, () => ({}));
  const waiting: Promise<unknown>[] = [];
  const owner = { kind: 'session' as const, id: 'session', runtimeId: 'runtime' };
  for (const channel of channels)
    for (let i = 0; i < 32; i++) waiting.push(hub.request({ channel, owner, emit: () => {} }, spec));
  expect(await hub.request({ channel: {}, owner, emit: () => {} }, spec)).toEqual({ action: 'cancel' });
  hub.cancelChannel(channels[0]!);
  expect(await hub.request({ channel: channels[1]!, owner, emit: () => {} }, spec)).toEqual({ action: 'cancel' });
  hub.cancelOwner(owner);
  await Promise.all(waiting);
  expect(await hub.request({ channel: {}, owner, emit: () => {} }, spec, { signal: AbortSignal.abort() })).toEqual({
    action: 'cancel',
  });
  expect(await hub.request({ channel: {}, owner, emit: () => {} }, { ...spec, title: '' })).toEqual({
    action: 'cancel',
  });
  hub.dispose();
});
it('URL提交与原生完成分开，完成通知须匹配连接、运行实例和原生身份', async () => {
  const hub = new InteractionHub();
  const channel = {};
  const events: InteractionEvent[] = [];
  const pending = hub.request(
    {
      channel,
      owner: { kind: 'session', id: 'session', runtimeId: 'runtime' },
      completionId: 'native-auth',
      emit: (event) => events.push(event),
    },
    { kind: 'url', title: '授权', blocking: true, url: 'https://example.test/login' },
  );
  const first = events[0];
  if (first?.type !== 'interaction_request') throw new Error('没有请求');
  hub.respond(channel, first.interaction.id, { action: 'submit', values: {} });
  await pending;
  expect(events.at(-1)).toMatchObject({ resolution: 'submitted' });
  hub.complete({}, 'runtime', 'native-auth');
  hub.complete(channel, 'other', 'native-auth');
  expect(events).toHaveLength(2);
  hub.complete(channel, 'runtime', 'native-auth');
  expect(events.at(-1)).toMatchObject({ resolution: 'completed' });
  expect(hub.respond(channel, first.interaction.id, { action: 'cancel' })).toBe(false);
  hub.dispose();
});
const spec: InteractionSpec = {
  kind: 'questions',
  title: '选择方案',
  blocking: true,
  fields: [
    {
      id: 'choice',
      type: 'choice',
      label: '方案',
      required: true,
      multiple: false,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
  ],
};
it('答复绑定宿主连接与唯一交互，错误拥有者、无效及重复答复不执行', async () => {
  const hub = new InteractionHub();
  const channel = {};
  const events: InteractionEvent[] = [];
  const result = hub.request(
    { channel, owner: { kind: 'turn', id: 'turn', runtimeId: 'runtime' }, emit: (event) => events.push(event) },
    spec,
  );
  const id = (events[0] as Extract<InteractionEvent, { type: 'interaction_request' }>).interaction.id;
  expect(hub.respond({}, id, { action: 'submit', values: { choice: 'a' } })).toBe(false);
  expect(hub.respond(channel, id, { action: 'submit', values: { choice: 'bad' } })).toBe(false);
  expect(hub.respond(channel, id, { action: 'submit', values: { choice: 'b' } })).toBe(true);
  expect(hub.respond(channel, id, { action: 'cancel' })).toBe(false);
  expect(await result).toEqual({ action: 'submit', values: { choice: 'b' } });
  expect(events[1]).toEqual({ type: 'interaction_resolved', id, resolution: 'submitted' });
});
it('无回合的操作表单不会被另一个回合完成取消，关闭运行实例才释放', async () => {
  const hub = new InteractionHub();
  const channel = {};
  const events: InteractionEvent[] = [];
  const owner = { kind: 'nativeOperation' as const, id: 'oauth', runtimeId: 'instance' };
  const result = hub.request({ channel, owner, emit: (e) => events.push(e) }, spec);
  hub.cancelOwner({ kind: 'turn', id: 'unrelated', runtimeId: 'instance' });
  expect(events).toHaveLength(1);
  hub.cancelRuntime('instance');
  expect(await result).toEqual({ action: 'cancel' });
  expect(
    hub.respond(channel, (events[0] as Extract<InteractionEvent, { type: 'interaction_request' }>).interaction.id, {
      action: 'submit',
      values: { choice: 'a' },
    }),
  ).toBe(false);
});
it('秘密值只交回原生处理，不出现在广播回执；超时和取消均结束等待', async () => {
  vi.useFakeTimers();
  const hub = new InteractionHub();
  const channel = {};
  const events: InteractionEvent[] = [];
  const owner = { kind: 'session' as const, id: 's', runtimeId: 'r' };
  const form: InteractionSpec = {
    kind: 'form',
    title: '输入',
    blocking: true,
    fields: [{ id: 'secret', type: 'text', label: '秘密', required: true, secret: true }],
  };
  const answer = hub.request({ channel, owner, emit: (e) => events.push(e) }, form);
  hub.respond(channel, (events[0] as Extract<InteractionEvent, { type: 'interaction_request' }>).interaction.id, {
    action: 'submit',
    values: { secret: 'private-value' },
  });
  expect(await answer).toMatchObject({ action: 'submit' });
  expect(JSON.stringify(events)).not.toContain('private-value');
  const pending = hub.request({ channel, owner, emit: (e) => events.push(e) }, spec, { timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(50);
  expect(await pending).toEqual({ action: 'cancel' });
  const abort = new AbortController();
  const cancelled = hub.request({ channel, owner, emit: () => {} }, spec, { signal: abort.signal });
  abort.abort();
  expect(await cancelled).toEqual({ action: 'cancel' });
});
