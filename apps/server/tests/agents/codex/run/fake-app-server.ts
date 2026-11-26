// 独立假进程：只实现测试所需协议，不访问真实配置或模型。
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { capabilityHandlers } from '../fake-capabilities';

type Message = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
const mode = process.env.CODEX_TEST_MODE ?? 'normal';
const logFile = process.env.CODEX_TEST_LOG;
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (message: Message, result: unknown) => write({ id: message.id, result });
const notify = (method: string, params: unknown) => write({ method, params });
const threadId = 'native-thread';
let turnId = 'native-turn';
let generatedTurns = 0;
let startedUsageTurns = 0;
let backgroundTerminal = ['background-terminal', 'background-terminal-natural-end'].includes(
  process.env.CODEX_TEST_MODE ?? '',
);
const thread = (id = threadId, cwd = process.cwd(), preview: string | null = '原生会话') => ({
  id,
  sessionId: 'fork-tree-root',
  forkedFromId: null,
  cwd,
  model: 'native-model',
  name: null,
  preview,
  createdAt: 1,
  updatedAt: 10,
  source: mode === 'subagent-session' ? { subAgent: 'review' } : 'appServer',
  parentThreadId: null,
  status: { type: mode === 'active-session' ? 'active' : 'notLoaded' },
  turns: [],
});
const end = (status = 'completed') =>
  notify('turn/completed', {
    threadId,
    turn: {
      id: turnId,
      status,
      items: [],
      durationMs: 30,
      error: status === 'failed' ? { message: 'fixture-sensitive-diagnostic' } : null,
    },
  });
const historyToolItems =
  mode === 'long-tool-history'
    ? [
        {
          id: 'long-tool',
          type: 'commandExecution',
          status: 'completed',
          command: 'fixture',
          aggregatedOutput: '原生工具结果'.repeat(5000) + '读取末尾',
          exitCode: 0,
        },
      ]
    : [];
const readThread = (message: Message) => {
  if (largeHistory(message)) return;
  const id = String(message.params?.threadId);
  const result = thread(
    mode === 'wrong-session-id' ? 'another-thread' : id,
    id === 'foreign' ? path.dirname(process.cwd()) : process.cwd(),
  );
  reply(message, { thread: { ...result, turns: message.params?.includeTurns ? historyTurns() : [] } });
};
function historyTurns() {
  const turns = [
    {
      id: 'old-turn',
      status: historyStatus(),
      itemsView: mode === 'partial-history' ? 'summary' : 'full',
      items: [
        { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '历史问题' }] },
        { id: 'assistant', type: 'agentMessage', text: '历史回复' },
        ...historyToolItems,
      ],
    },
  ];
  if (mode.startsWith('fork-'))
    turns.push({
      id: 'later-turn',
      status: 'completed',
      itemsView: 'full',
      items: [
        { id: 'later-user', type: 'userMessage', content: [{ type: 'text', text: '后续问题' }] },
        { id: 'later-assistant', type: 'agentMessage', text: '后续回复' },
      ],
    });
  return turns;
}
function listHistoryTurns(message: Message) {
  if (mode === 'partial-history') {
    write({ id: message.id, error: { code: -32601, message: 'old fixture' } });
    return;
  }
  const limit = Number(message.params?.limit ?? 3);
  if (mode === 'paging-overflow' && limit > 1) {
    reply(message, {
      data: [
        {
          ...historyTurns()[0],
          items: [{ id: 'large-reply', type: 'agentMessage', text: 'a'.repeat(9 * 1024 * 1024) }],
        },
      ],
    });
    return;
  }
  const data = historyTurns()
    .reverse()
    .slice(0, limit)
    .map((turn) => (message.params?.itemsView === 'notLoaded' ? { ...turn, itemsView: 'notLoaded', items: [] } : turn));
  reply(message, { data, nextCursor: null });
}
function historyStatus(): string {
  return mode === 'fork-in-progress' ? 'inProgress' : mode === 'fork-unknown-status' ? 'unknown' : 'completed';
}
function largeHistory(message: Message): boolean {
  if (mode !== 'large-text-history' && mode !== 'large-image-history') return false;
  const item =
    mode === 'large-image-history'
      ? {
          type: 'userMessage',
          content: [{ type: 'image', url: 'data:image/png;base64,' + 'a'.repeat(9 * 1024 * 1024) }],
        }
      : { type: 'agentMessage', text: 'a'.repeat(9 * 1024 * 1024) };
  reply(message, { thread: { ...thread(), turns: [{ items: [item] }] } });
  return true;
}
function listThreads(message: Message): void {
  const cursor = message.params?.cursor;
  const first = [
    thread(),
    thread('foreign', path.dirname(process.cwd())),
    { ...thread('subagent'), parentThreadId: 'parent', source: { subAgent: {} } },
  ];
  reply(message, {
    // 第二页的线程既没有 name 也没有 preview，用于验证标题不会退回服务端占位文案。
    data: cursor ? [thread('second', process.cwd(), null)] : first,
    nextCursor: !cursor || mode === 'cursor-loop' ? 'page-2' : null,
  });
}
function approval(): void {
  const kind = mode === 'approval-permissions' ? 'permissions' : 'commandExecution';
  write({
    id: 'native-approval-id',
    method: `item/${kind}/requestApproval`,
    params: {
      threadId,
      turnId,
      itemId: 'same-item',
      reason: '需要本次确认',
      cwd: process.cwd(),
      command: 'echo test',
      permissions: { network: { enabled: true }, fileSystem: { read: ['project'], write: null } },
    },
  });
}
function reportUsage(): void {
  if (mode.startsWith('usage')) {
    generatedTurns += 1;
    if (!(mode === 'usage-missing' && generatedTurns === 2))
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: {
          total: {
            inputTokens: generatedTurns * 100,
            outputTokens: generatedTurns * 20,
            totalTokens: generatedTurns * 120,
          },
          last: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          modelContextWindow: 1000,
        },
      });
  }
}
function afterStart(): void {
  if (mode.startsWith('steer')) return;
  if (mode.startsWith('approval')) {
    approval();
    if (mode === 'approval-exit') setTimeout(() => process.exit(1), 40);
    return;
  }
  if (mode === 'unknown-request') {
    write({ id: 900, method: 'item/unsupported/request', params: { threadId, turnId } });
    return;
  }
  if (mode === 'delayed-start' || mode === 'ignore-interrupt') return;
  if (mode === 'foreign-turn-completion')
    notify('turn/completed', {
      threadId,
      turnId,
      turn: {
        id: 'foreign-turn',
        status: 'completed',
        items: [{ id: 'foreign-answer', type: 'agentMessage', text: '不属于本轮' }],
      },
    });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: '流式回复' });
  notify('item/completed', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', text: '流式回复' } });
  reportUsage();
  end(mode === 'turn-failed' ? 'failed' : 'completed');
  if (mode === 'background-terminal-natural-end')
    setTimeout(() => {
      backgroundTerminal = false;
    }, 300);
}
function start(message: Message): void {
  const respond = () => {
    if (mode.startsWith('usage')) {
      const previous = turnId;
      turnId = `native-turn-${++startedUsageTurns}`;
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId: 'foreign-turn',
        tokenUsage: { total: { outputTokens: 999 }, last: { totalTokens: 999 } },
      });
      if (mode === 'usage-late' && startedUsageTurns === 2)
        notify('thread/tokenUsage/updated', {
          threadId,
          turnId: previous,
          tokenUsage: { total: { inputTokens: 150, outputTokens: 25, totalTokens: 175 }, last: { totalTokens: 15 } },
        });
    }
    reply(message, { turn: { id: turnId, status: 'inProgress', items: [] } });
    setTimeout(afterStart, 10);
  };
  if (mode === 'delayed-start') setTimeout(respond, 150);
  else respond();
}
function config(message: Message): void {
  if (mode === 'rpc-error') {
    write({ id: message.id, error: { code: -32000, message: 'fixture-sensitive-diagnostic' } });
    return;
  }
  if (mode !== 'wait-config')
    reply(message, {
      config: {
        developer_instructions: '原生约束',
        model: mode.startsWith('catalog-no-') ? undefined : 'native-model',
        model_reasoning_effort: mode === 'catalog' ? 'medium' : undefined,
        model_provider: 'native-provider',
      },
    });
}
function echo(message: Message): void {
  const bytes = Buffer.from(`${JSON.stringify({ id: message.id, result: { value: '中文分片' } })}\n`);
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  process.stdout.write(bytes.subarray(0, split));
  setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
}
function mutation(message: Message): void {
  const complete = () => {
    if (logFile) appendFileSync(logFile, `${JSON.stringify({ fixtureCompleted: message.method })}\n`);
    reply(message, {});
  };
  if (mode === 'delayed-mutation') setTimeout(complete, 150);
  else complete();
}
function forkThread(message: Message): void {
  if (mode === 'fork-rpc-error') {
    write({ id: message.id, error: { code: -32000, message: 'fixture-sensitive-fork-diagnostic' } });
    return;
  }
  const overrides: Record<string, Record<string, unknown>> = {
    'fork-same-id': { id: threadId },
    'fork-empty-id': { id: '' },
    'fork-invalid-id': { id: '../session-file' },
    'fork-wrong-cwd': { cwd: path.dirname(process.cwd()) },
    'fork-child-agent': { parentThreadId: 'parent', source: { subAgent: 'review' } },
    'fork-wrong-source': { forkedFromId: 'another-thread' },
  };
  const complete = () => {
    if (logFile) appendFileSync(logFile, `${JSON.stringify({ fixtureCompleted: 'thread/fork' })}\n`);
    reply(message, { thread: { ...thread('forked-thread'), forkedFromId: threadId, ...overrides[mode] } });
  };
  if (mode === 'fork-delayed') setTimeout(complete, 150);
  else complete();
}
const handlers: Record<string, (message: Message) => void> = {
  ...capabilityHandlers(mode, {
    reply,
    notify,
    write,
    mark: (name) => {
      if (logFile) appendFileSync(logFile, `${JSON.stringify({ fixturePhase: name })}\n`);
    },
  }),
  initialize: (message) => reply(message, { userAgent: 'fixture' }),
  initialized: () => {},
  'config/read': config,
  'thread/start': (message) => {
    if (mode === 'permission-denied')
      return write({
        id: message.id,
        error: { code: -32600, message: 'approvalsReviewer auto_review is not allowed; private-fixture-details' },
      });
    if (message.params?.ephemeral)
      return reply(message, {
        thread: thread('permission-baseline'),
        model: 'native-model',
        approvalPolicy: 'on-request',
        approvalsReviewer: mode === 'native-incomplete' ? undefined : 'auto_review',
        sandbox: { type: 'readOnly' },
        ...(mode === 'native-profile' ? { activePermissionProfile: { id: 'project-custom' } } : {}),
      });
    reply(message, { thread: thread(), model: 'native-model' });
  },
  'thread/unsubscribe': (message) => reply(message, {}),
  'thread/resume': (message) =>
    reply(message, { thread: thread(String(message.params?.threadId)), model: 'native-model' }),
  'thread/read': readThread,
  'thread/turns/list': listHistoryTurns,
  'thread/goal/get': (message) =>
    reply(message, {
      goal: mode === 'active-goal' ? { threadId, status: 'active', objective: 'fixture' } : null,
    }),
  'thread/backgroundTerminals/list': (message) =>
    mode === 'unsupported-background-terminals'
      ? write({ id: message.id, error: { code: -32601, message: 'not supported' } })
      : reply(message, {
          data: backgroundTerminal
            ? [{ itemId: 'fixture-item', processId: 'fixture-process', command: 'secret', cwd: 'secret' }]
            : [],
          nextCursor: null,
        }),
  'thread/backgroundTerminals/terminate': (message) => {
    const terminated = backgroundTerminal && message.params?.processId === 'fixture-process';
    if (terminated) backgroundTerminal = false;
    reply(message, { terminated });
  },
  'thread/backgroundTerminals/clean': (message) => {
    backgroundTerminal = false;
    reply(message, {});
  },
  'thread/list': listThreads,
  'thread/fork': forkThread,
  'thread/name/set': mutation,
  'thread/delete': mutation,
  'thread/archive': mutation,
  'thread/unarchive': mutation,
  'turn/start': start,
  'review/start': start,
  'collaborationMode/list': (message) => reply(message, { data: [{ mode: 'plan' }, { mode: 'default' }] }),
  'turn/steer': (message) => {
    if (mode === 'steer-rejected' || message.params?.expectedTurnId !== turnId) {
      write({ id: message.id, error: { code: -32600, message: 'wrong turn' } });
      return;
    }
    if (mode === 'steer-unknown') {
      process.exit(1);
      return;
    }
    notify('item/completed', {
      threadId,
      turnId,
      item: {
        type: 'userMessage',
        id: 'steered',
        clientId: message.params?.clientUserMessageId,
        content: message.params?.input,
      },
    });
    reply(message, { turnId });
    setTimeout(() => end(), 10);
  },
  'turn/interrupt': (message) => {
    if (mode !== 'ignore-interrupt') {
      reply(message, {});
      end('interrupted');
    }
  },
  echo,
  'fixture/media-notification': (message) => {
    const item = message.params?.invalid
      ? { type: 'agentMessage', text: 'a'.repeat(9 * 1024 * 1024) }
      : { type: 'mcpToolCall', result: { content: [{ type: 'image', data: 'a'.repeat(9 * 1024 * 1024) }] } };
    notify('item/completed', { item });
    reply(message, {});
  },
  hang: () => {},
  oversize: () => {
    process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
  },
  exit: () => {
    process.stderr.write('fixture-secret-must-not-leak');
    process.exit(1);
  },
};
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const message = JSON.parse(line) as Message;
    if (logFile) appendFileSync(logFile, `${JSON.stringify(message)}\n`);
    if (message.method) handlers[message.method]?.(message);
    else end();
  })
  .on('close', () => process.exit(0));
