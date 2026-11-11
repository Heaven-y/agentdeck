import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecoveryServerMessage } from '@agentdeck/shared/conversation';
import type { AgentTurnInput } from '../../src/agents/contracts';
import { ResumeHub, type ResumeLimits, type ResumePeer } from '../../src/chat/resume-hub';
import { TurnManager } from '../../src/chat/turn-manager';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const request = (token: string, extra = {}) => ({
  type: 'connection.resume' as const,
  token,
  create: false,
  rebuild: false,
  afterSequence: 0,
  ...extra,
});
const send = (clientTurnId = 'first') => ({
  type: 'chat.send' as const,
  workspaceId: 'demo',
  agent: 'claude' as const,
  text: '合成消息',
  clientTurnId,
});
function peer() {
  const messages: RecoveryServerMessage[] = [];
  const value: ResumePeer = {
    send: (data) => messages.push(JSON.parse(data) as RecoveryServerMessage),
    isOpen: () => true,
  };
  return { value, messages };
}
function setup(limits: Partial<ResumeLimits> = {}) {
  const runs: Array<{ input: AgentTurnInput; finish(): void; interrupted: boolean }> = [];
  const turns = new TurnManager({
    getWorkspace: async () => ({ id: 'demo', name: 'demo', dir: process.cwd() }),
    sessions: { assertBelongs: async () => undefined },
    runners: {
      claude: (input) => {
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const run = { input, finish, interrupted: false };
        runs.push(run);
        return {
          done,
          interrupt: async () => {
            run.interrupted = true;
            finish();
          },
        };
      },
    },
  });
  const hub = new ResumeHub(turns, limits);
  return {
    hub,
    runs,
    turns,
    dispose: async () => {
      hub.dispose();
      await turns.dispose();
    },
  };
}

it('会话表单独立于旧回合回收，刷新可回答且秘密答案不进入恢复缓存', async () => {
  const f = setup({ completedMs: 100, offlineMs: 1000 });
  try {
    const token = randomUUID();
    const a = peer();
    const socket = f.hub.attach(a.value, request(token, { create: true }))!;
    await f.hub.handle(a.value, socket, send());
    const answer = f.runs[0]!.input.requestInteraction!({
      runtimeId: 'runtime',
      scope: { kind: 'session', id: 'native' },
      spec: {
        kind: 'form',
        title: '授权',
        blocking: true,
        fields: [{ id: 'key', type: 'text', label: '密钥', secret: true, required: true }],
      },
    });
    const sent = a.messages.find((m) => m.type === 'connection.event' && m.message.type === 'interaction.event');
    if (
      sent?.type !== 'connection.event' ||
      sent.message.type !== 'interaction.event' ||
      sent.message.event.type !== 'interaction_request'
    )
      throw new Error('缺少表单');
    f.runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(201);
    f.hub.detach(a.value, socket);
    const b = peer();
    const resumed = f.hub.attach(b.value, request(token, { rebuild: true }))!;
    expect(b.messages.some((m) => m.type === 'connection.event' && m.message.type === 'interaction.event')).toBe(true);
    await f.hub.handle(b.value, resumed, {
      type: 'interaction.respond',
      id: sent.message.event.interaction.id,
      answer: { action: 'submit', values: { key: 'secret-answer' } },
    });
    expect(await answer).toEqual({ action: 'submit', values: { key: 'secret-answer' } });
    f.hub.detach(b.value, resumed);
    const c = peer();
    f.hub.attach(c.value, request(token, { rebuild: true }));
    expect(JSON.stringify(c.messages)).not.toContain('secret-answer');
    expect(
      c.messages.some(
        (m) =>
          m.type === 'connection.event' &&
          m.message.type === 'interaction.event' &&
          m.message.event.type === 'interaction_resolved',
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(201);
    f.hub.detach(c.value, resumed);
    const d = peer();
    f.hub.attach(d.value, request(token, { rebuild: true }));
    expect(d.messages.some((m) => m.type === 'connection.event' && m.message.type === 'interaction.event')).toBe(false);
  } finally {
    await f.dispose();
  }
});

it('离线宽限到期中断所有回合并取消审批，超时身份不能复活；关闭后端同样清理', async () => {
  const f = setup({ offlineMs: 100 });
  try {
    const a = peer();
    const token = randomUUID();
    const socket = f.hub.attach(a.value, request(token, { create: true, rebuild: true }))!;
    await f.hub.handle(a.value, socket, send());
    await f.hub.handle(a.value, socket, send('second'));
    const permission = f.runs[0]!.input.requestPermission({ requestId: 'approval', toolName: 'command', input: {} });
    f.hub.detach(a.value, socket);
    await vi.advanceTimersByTimeAsync(99);
    expect(f.runs.every((run) => !run.interrupted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runs.every((run) => run.interrupted)).toBe(true);
    expect(await permission).toMatchObject({ allow: false });
    const retry = peer();
    expect(f.hub.attach(retry.value, request(token))).toBeUndefined();
    expect(retry.messages).toMatchObject([{ type: 'connection.rejected', code: 'owner_missing' }]);
    const next = peer();
    const nextSocket = f.hub.attach(next.value, request(randomUUID(), { create: true }))!;
    await f.hub.handle(next.value, nextSocket, send('third'));
    f.hub.dispose();
    expect(f.runs[2]!.interrupted).toBe(true);
    expect(next.messages.at(-1)).toMatchObject({ type: 'connection.rejected', code: 'server_closed' });
  } finally {
    await f.dispose();
  }
});

it('单页缓存超限立即停止其回合，不泄露给其他身份，释放预算后可建立新连接', async () => {
  const f = setup({ ownerBytes: 2500, totalBytes: 5000 });
  try {
    const a = peer();
    const token = randomUUID();
    const socket = f.hub.attach(a.value, request(token, { create: true }))!;
    await f.hub.handle(a.value, socket, send());
    f.runs[0]!.input.emit({ type: 'text', delta: '大'.repeat(1500) });
    expect(a.messages.at(-1)).toMatchObject({ type: 'connection.rejected', code: 'capacity' });
    expect(f.runs[0]!.interrupted).toBe(true);
    const other = peer();
    const second = f.hub.attach(other.value, request(randomUUID(), { create: true, rebuild: true }))!;
    expect(other.messages[0]).toEqual({ type: 'connection.snapshot', turns: [] });
    await f.hub.handle(other.value, second, send('next'));
    expect(f.runs).toHaveLength(2);
    expect(f.runs[1]!.interrupted).toBe(false);
  } finally {
    await f.dispose();
  }
});

it('总预算和连接数量有界，耗尽时只拒绝新占用，不中断其他页签', async () => {
  const f = setup({ owners: 2, ownerBytes: 5000, totalBytes: 2500 });
  try {
    const a = peer();
    const b = peer();
    const third = peer();
    const first = f.hub.attach(a.value, request(randomUUID(), { create: true }))!;
    const second = f.hub.attach(b.value, request(randomUUID(), { create: true }))!;
    expect(f.hub.attach(third.value, request(randomUUID(), { create: true }))).toBeUndefined();
    expect(third.messages[0]).toMatchObject({ code: 'capacity' });
    await f.hub.handle(a.value, first, send());
    await f.hub.handle(b.value, second, send('other'));
    expect(b.messages.at(-1)).toMatchObject({ code: 'capacity' });
    expect(f.runs[0]!.interrupted).toBe(false);
  } finally {
    await f.dispose();
  }
});

it('待发列表独立于旧回合TTL恢复，离线暂停后显式继续，自动派发输入刷新不重发', async () => {
  const f = setup({ completedMs: 100, offlineMs: 1000 });
  try {
    const token = randomUUID(),
      a = peer();
    const socket = f.hub.attach(a.value, request(token, { create: true }))!;
    await f.hub.handle(a.value, socket, { ...send(), conversationId: 'draft' });
    f.runs[0]!.input.emit({ type: 'session', sessionId: 'native', model: 'fixture', cwd: process.cwd() });
    await vi.advanceTimersByTimeAsync(0);
    const queueId = f.turns.followups.snapshots(socket)[0]!.queueId;
    const clientMessageId = randomUUID();
    await f.hub.handle(a.value, socket, {
      type: 'chat.followup',
      queueId,
      clientMessageId,
      mode: 'queue',
      content: { text: 'queued' },
    });
    f.hub.detach(a.value, socket);
    f.runs[0]!.input.emit({ type: 'turn_end', isError: false });
    f.runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(101);
    expect(f.runs).toHaveLength(1);
    const b = peer();
    f.hub.attach(b.value, request(token, { rebuild: true }));
    expect(b.messages[0]).toEqual({ type: 'connection.snapshot', turns: [] });
    expect(b.messages.find((message) => message.type === 'connection.followups')).toMatchObject({
      snapshots: [{ paused: true, sessionId: 'native', items: [{ clientMessageId, status: 'queued' }] }],
    });
    await f.hub.handle(b.value, socket, { type: 'followup.resume', queueId });
    expect(f.runs).toHaveLength(2);
    f.hub.detach(b.value, socket);
    const c = peer();
    f.hub.attach(c.value, request(token, { rebuild: true }));
    expect(c.messages[0]).toMatchObject({
      type: 'connection.snapshot',
      turns: [{ message: { text: 'queued', sessionId: 'native' } }],
    });
    const snapshot = c.messages[0]!;
    if (snapshot.type !== 'connection.snapshot') throw new Error('缺少恢复输入');
    const attemptedId = snapshot.turns[0]!.message.clientTurnId;
    expect(attemptedId).not.toBe(clientMessageId);
    await f.hub.handle(c.value, socket, { ...send(attemptedId), text: 'queued' });
    expect(f.runs).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});

it('URL已提交但原生尚未确认完成时，不按已完成交互TTL丢弃授权状态', async () => {
  const f = setup({ completedMs: 100, offlineMs: 1000 });
  try {
    const token = randomUUID(),
      a = peer();
    const socket = f.hub.attach(a.value, request(token, { create: true }))!;
    await f.hub.handle(a.value, socket, send());
    const answer = f.runs[0]!.input.requestInteraction!({
      runtimeId: 'runtime',
      completionId: 'authorization',
      scope: { kind: 'session', id: 'native' },
      spec: { kind: 'url', title: '本机合成授权', blocking: false, url: 'https://example.com/authorize' },
    });
    const sent = a.messages.find(
      (message) => message.type === 'connection.event' && message.message.type === 'interaction.event',
    );
    if (
      sent?.type !== 'connection.event' ||
      sent.message.type !== 'interaction.event' ||
      sent.message.event.type !== 'interaction_request'
    )
      throw new Error('缺少授权');
    const id = sent.message.event.interaction.id;
    await f.hub.handle(a.value, socket, { type: 'interaction.respond', id, answer: { action: 'submit', values: {} } });
    await answer;
    f.runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(101);
    f.hub.detach(a.value, socket);
    const b = peer();
    f.hub.attach(b.value, request(token, { rebuild: true }));
    expect(
      b.messages.some(
        (message) =>
          message.type === 'connection.event' &&
          message.message.type === 'interaction.event' &&
          message.message.event.type === 'interaction_request',
      ),
    ).toBe(true);
    f.runs[0]!.input.completeInteraction!('runtime', 'authorization');
    await vi.advanceTimersByTimeAsync(101);
    f.hub.detach(b.value, socket);
    const c = peer();
    f.hub.attach(c.value, request(token, { rebuild: true }));
    expect(
      c.messages.some((message) => message.type === 'connection.event' && message.message.type === 'interaction.event'),
    ).toBe(false);
  } finally {
    await f.dispose();
  }
});

it('排队准备被拒绝后，显式编辑重试使用新轮次送达ID，不被旧恢复回执吞掉', async () => {
  let available = true;
  const runs: Array<{ input: AgentTurnInput; finish(): void }> = [];
  const turns = new TurnManager({
    getWorkspace: async () => (available ? { id: 'demo', name: 'demo', dir: process.cwd() } : undefined),
    sessions: { assertBelongs: async () => {} },
    runners: {
      claude: (input) => {
        let resolve!: () => void;
        const done = new Promise<void>((r) => {
          resolve = r;
        });
        runs.push({
          input,
          finish: () => {
            input.emit({ type: 'turn_end', isError: false });
            resolve();
          },
        });
        return { done, interrupt: async () => resolve() };
      },
    },
  });
  const hub = new ResumeHub(turns),
    a = peer();
  try {
    const socket = hub.attach(a.value, request(randomUUID(), { create: true }))!;
    await hub.handle(a.value, socket, { ...send(), sessionId: 'native' });
    const queueId = turns.followups.snapshots(socket)[0]!.queueId,
      clientMessageId = randomUUID();
    await hub.handle(a.value, socket, {
      type: 'chat.followup',
      queueId,
      clientMessageId,
      mode: 'queue',
      content: { text: 'queued' },
    });
    available = false;
    runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(0);
    const failed = turns.followups.snapshots(socket)[0]!.items[0]!;
    expect(failed.status).toBe('failed');
    available = true;
    await hub.handle(a.value, socket, {
      type: 'followup.edit',
      queueId,
      clientMessageId,
      revision: failed.revision,
      content: { text: 'edited' },
    });
    await hub.handle(a.value, socket, { type: 'followup.resume', queueId });
    expect(runs).toHaveLength(2);
    expect(runs[1]!.input.text).toBe('edited');
    runs[1]!.finish();
  } finally {
    hub.dispose();
    await turns.dispose();
  }
});
it('父回合记录过期后后台任务快照独立恢复，当前实例任务可停止', async () => {
  const f = setup({ completedMs: 100, offlineMs: 1000 });
  try {
    const token = randomUUID(),
      a = peer(),
      socket = f.hub.attach(a.value, request(token, { create: true }))!;
    await f.hub.handle(a.value, socket, send());
    let tasks = [{ id: 'background', sessionId: 'native', status: 'running' as const, canStop: true }];
    let changed = () => {};
    const runtimeId = randomUUID(),
      stop = vi.fn(async () => {
        tasks = [];
        changed();
      });
    f.runs[0]!.input.registerRuntime!({
      instanceId: runtimeId,
      sessionId: 'native',
      tasks: () => tasks,
      stopTask: stop,
      invalidateResources: async () => {},
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
    });
    f.runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(101);
    f.hub.detach(a.value, socket);
    const b = peer();
    f.hub.attach(b.value, request(token, { rebuild: true }));
    expect(b.messages.find((message) => message.type === 'connection.tasks')).toMatchObject({
      states: [{ runtimeId, sessionId: 'native', tasks: [{ id: 'background' }] }],
    });
    await f.hub.handle(b.value, socket, {
      type: 'task.stop',
      workspaceId: 'demo',
      agent: 'claude',
      sessionId: 'native',
      runtimeId,
      taskId: 'background',
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(f.turns.tasks.busy('claude')).toBe(false);
  } finally {
    await f.dispose();
  }
});

it('已完成回合TTL释放正文；遗漏结束事件的游标失败，刷新仍可恢复所有运行回合', async () => {
  const f = setup({ completedMs: 100, offlineMs: 1000 });
  try {
    const a = peer();
    const token = randomUUID();
    const socket = f.hub.attach(a.value, request(token, { create: true }))!;
    await f.hub.handle(a.value, socket, send());
    await f.hub.handle(a.value, socket, send('background'));
    f.runs[0]!.finish();
    await vi.advanceTimersByTimeAsync(101);
    f.hub.detach(a.value, socket);
    const refreshed = peer();
    const resumed = f.hub.attach(refreshed.value, request(token, { rebuild: true }))!;
    expect(refreshed.messages[0]).toMatchObject({
      type: 'connection.snapshot',
      turns: [{ message: { clientTurnId: 'background' } }],
    });
    const snapshot = refreshed.messages[0]!;
    expect(snapshot.type === 'connection.snapshot' && snapshot.turns).toHaveLength(1);
    f.hub.detach(refreshed.value, resumed);
    const stale = peer();
    expect(f.hub.attach(stale.value, request(token, { afterSequence: 1 }))).toBeUndefined();
    expect(stale.messages.at(-1)).toMatchObject({ code: 'cache_expired' });
    expect(f.runs[1]!.interrupted).toBe(true);
  } finally {
    await f.dispose();
  }
});

it('同一页面可更换半开网络连接，其他页面仍被拒绝，旧连接迟到操作不影响恢复后的回合', async () => {
  const f = setup();
  try {
    const token = randomUUID();
    const instanceId = randomUUID();
    const a = peer();
    const b = peer();
    const other = peer();
    const socket = f.hub.attach(a.value, request(token, { create: true, instanceId }))!;
    await f.hub.handle(a.value, socket, send());
    const started = a.messages.find(
      (message) => message.type === 'connection.event' && message.message.type === 'turn.started',
    );
    if (started?.type !== 'connection.event' || started.message.type !== 'turn.started') throw new Error('缺少轮次');
    expect(f.hub.attach(other.value, request(token, { instanceId: randomUUID() }))).toBeUndefined();
    const resumed = f.hub.attach(b.value, request(token, { instanceId, afterSequence: 1 }));
    expect(resumed).toBe(socket);
    f.hub.detach(a.value, socket);
    await f.hub.handle(a.value, socket, { type: 'chat.interrupt', turnId: started.message.turnId });
    expect(f.runs[0]!.interrupted).toBe(false);
    f.runs[0]!.input.emit({ type: 'text', delta: '重连后输出' });
    expect(b.messages.at(-1)).toMatchObject({ type: 'connection.event', message: { event: { delta: '重连后输出' } } });
  } finally {
    await f.dispose();
  }
});
