import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, FollowupSnapshot, RecoveryNotice, ServerMessage } from '@agentdeck/shared/conversation';
import { sessionsApi } from '../../../src/features/sessions/api';
import { startChatConnection, useChat } from '../../../src/features/chat/chat-store';
import { queueHasPending } from '../../../src/features/chat/followup-state';

const queueId = '00000000-0000-4000-8000-000000000001';
const sent: ClientMessage[] = [];
let emit!: (message: ServerMessage) => void;
let recover!: (notice: RecoveryNotice) => void;
beforeAll(() =>
  startChatConnection((handlers) => {
    emit = handlers.onMessage;
    recover = handlers.onRecovery!;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      reconnect() {},
      close() {},
    };
  }),
);
beforeEach(() => {
  sent.length = 0;
  vi.spyOn(sessionsApi, 'sessionPermission').mockResolvedValue({ permission: null });
  useChat.setState(useChat.getInitialState(), true);
  useChat.getState().selectWorkspace('project');
  useChat.setState({ connection: 'open', agent: 'codex', sessionId: 'session' });
});
afterEach(() => vi.restoreAllMocks());
function running() {
  useChat.getState().send('第一条');
  const first = sent[0] as Extract<ClientMessage, { type: 'chat.send' }>;
  emit({
    type: 'turn.started',
    turnId: 'turn',
    clientTurnId: first.clientTurnId,
    workspaceId: 'project',
    agent: 'codex',
    queueId,
  });
  return first;
}
function snapshot(items: FollowupSnapshot['items'] = []): FollowupSnapshot {
  return {
    queueId,
    workspaceId: 'project',
    agent: 'codex',
    conversationId: useChat.getState().conversationId,
    sessionId: 'session',
    revision: 1,
    paused: false,
    activeTurnId: 'turn',
    canSteer: true,
    items,
  };
}
it('运行中默认排队，确认回执才清对应草稿，迟到确认不删新草稿', () => {
  running();
  emit({ type: 'followup.state', snapshot: snapshot() });
  useChat.getState().setDraft('下一条');
  expect(useChat.getState().send('下一条')).toBe(true);
  const queued = sent.at(-1) as Extract<ClientMessage, { type: 'chat.followup' }>;
  expect(queued).toMatchObject({ type: 'chat.followup', queueId, mode: 'queue', content: { text: '下一条' } });
  expect(useChat.getState().draft).toBe('下一条');
  useChat.getState().setDraft('刚写的新草稿');
  emit({
    type: 'followup.state',
    snapshot: snapshot([
      {
        clientMessageId: queued.clientMessageId,
        revision: 0,
        mode: 'queue',
        status: 'queued',
        text: '下一条',
        content: queued.content,
      },
    ]),
  });
  expect(useChat.getState().draft).toBe('刚写的新草稿');
  expect(useChat.getState().items.filter((item) => item.kind === 'user')).toHaveLength(1);
});
it('引导只在即时证据和本轮参数匹配时发送，确认delivered去重挂原后台会话', () => {
  running();
  const origin = useChat.getState().conversationId;
  emit({ type: 'followup.state', snapshot: snapshot() });
  useChat.getState().setDraft('引导文本');
  expect(useChat.getState().sendFollowup('引导文本', 'steer')).toBe(true);
  const message = sent.at(-1) as Extract<ClientMessage, { type: 'chat.followup' }>;
  expect(message).toMatchObject({ mode: 'steer', turnId: 'turn' });
  useChat.getState().newSession('claude');
  const delivery: Extract<ServerMessage, { type: 'followup.delivered' }> = {
    type: 'followup.delivered',
    queueId,
    clientMessageId: message.clientMessageId,
    turnId: 'turn',
    workspaceId: 'project',
    agent: 'codex',
    conversationId: origin,
    sessionId: 'session',
    text: '引导文本',
  };
  emit(delivery);
  emit(delivery);
  expect(useChat.getState().items).toEqual([]);
  expect(useChat.getState().background[origin]!.items.filter((item) => item.kind === 'user')).toHaveLength(2);
  useChat.getState().openConversation(origin);
  useChat.getState().setModel('new-model');
  expect(useChat.getState().sendFollowup('不能换模型引导', 'steer')).toBe(false);
});
it('自动开始使用独立clientTurnId建立前后台消息，重复started不重复追加', () => {
  running();
  const origin = useChat.getState().conversationId;
  const state = snapshot();
  emit({ type: 'followup.state', snapshot: state });
  useChat.getState().newSession('claude');
  const input: Extract<ClientMessage, { type: 'chat.send' }> = {
    type: 'chat.send',
    clientTurnId: 'attempt-new-id',
    workspaceId: 'project',
    agent: 'codex',
    conversationId: origin,
    sessionId: 'session',
    text: '自动下一轮',
  };
  const started: Extract<ServerMessage, { type: 'turn.started' }> = {
    type: 'turn.started',
    clientTurnId: input.clientTurnId,
    turnId: 'next-turn',
    workspaceId: 'project',
    agent: 'codex',
    queueId,
    followupClientMessageId: '00000000-0000-4000-8000-000000000002',
    input,
  };
  emit(started);
  emit(started);
  emit({ type: 'agent.event', turnId: 'next-turn', event: { type: 'text', delta: '后台回复' } });
  expect(useChat.getState().items).toEqual([]);
  const background = useChat.getState().background[origin]!;
  expect(background.turnId).toBe('next-turn');
  expect(background.items.filter((item) => item.kind === 'user')).toHaveLength(2);
  expect(JSON.stringify(background.items)).toContain('后台回复');
});
it('刷新恢复最新队列，后端拒绝只保留为失效备份且不重新入队', () => {
  const state = snapshot([
    {
      clientMessageId: '00000000-0000-4000-8000-000000000002',
      revision: 0,
      mode: 'queue',
      status: 'queued',
      text: '恢复文字',
      content: { text: '恢复文字' },
    },
  ]);
  recover({ type: 'connection.followups', snapshots: [state] });
  expect(useChat.getState().followups[queueId]?.snapshot.items[0]?.text).toBe('恢复文字');
  recover({ type: 'connection.rejected', code: 'owner_missing', message: '后端已重启' });
  expect(useChat.getState().followups[queueId]?.invalid).toBe(true);
  expect(sent).toEqual([]);
});
it('刷新重建自动input再重放started不追加重复用户消息', () => {
  const input: Extract<ClientMessage, { type: 'chat.send' }> = {
    type: 'chat.send',
    workspaceId: 'project',
    agent: 'codex',
    conversationId: 'restored-conversation',
    sessionId: 'session',
    clientTurnId: 'restored-attempt',
    text: '恢复自动轮次',
  };
  recover({ type: 'connection.snapshot', turns: [{ message: input, sentAt: 1 }] });
  emit({
    type: 'turn.started',
    turnId: 'restored-turn',
    clientTurnId: input.clientTurnId,
    workspaceId: 'project',
    agent: 'codex',
    queueId,
    followupClientMessageId: '00000000-0000-4000-8000-000000000002',
    input,
  });
  const view = useChat.getState().background[input.conversationId!] ?? useChat.getState();
  expect(view.items.filter((item) => item.kind === 'user')).toHaveLength(1);
});
it('unknown不能编辑或重发，clear仅清可清条目；错误回执保持草稿可恢复', () => {
  running();
  emit({ type: 'followup.state', snapshot: snapshot() });
  useChat.getState().setDraft('未确认');
  useChat.getState().send('未确认');
  const message = sent.at(-1) as Extract<ClientMessage, { type: 'chat.followup' }>;
  emit({ type: 'followup.error', queueId, clientMessageId: message.clientMessageId, message: '已被另一页占用' });
  expect(useChat.getState().draft).toBe('未确认');
  emit({
    type: 'followup.state',
    snapshot: snapshot([
      {
        clientMessageId: message.clientMessageId,
        revision: 2,
        mode: 'steer',
        status: 'unknown',
        text: '未确认',
        content: message.content,
      },
    ]),
  });
  expect(useChat.getState().editFollowup(queueId, message.clientMessageId, '不准编辑')).toBe(false);
  const before = sent.length;
  expect(useChat.getState().resumeFollowups(queueId)).toBe(false);
  expect(sent).toHaveLength(before);
  expect(useChat.getState().cancelFollowup(queueId, message.clientMessageId)).toBe(true);
  expect(sent.at(-1)).toMatchObject({ type: 'followup.cancel', revision: 2 });
});
it('仍在排队的条目不能复制回草稿形成第二次投递', () => {
  emit({
    type: 'followup.state',
    snapshot: snapshot([
      {
        clientMessageId: 'queued',
        revision: 0,
        mode: 'queue',
        status: 'queued',
        text: '待发',
        content: { text: '待发' },
      },
    ]),
  });
  useChat.getState().setDraft('当前草稿');
  useChat.getState().restoreFollowup(queueId, 'queued');
  expect(useChat.getState().draft).toBe('当前草稿');
  expect(useChat.getState().banner).toContain('仍在列表');
});
it('刷新后没有技能详情时不静默丢弃原生选择', () => {
  emit({
    type: 'followup.state',
    snapshot: snapshot([
      {
        clientMessageId: 'failed',
        revision: 0,
        mode: 'queue',
        status: 'failed',
        text: '参数',
        content: { text: '参数', selection: { id: 'review' } },
      },
    ]),
  });
  useChat.getState().restoreFollowup(queueId, 'failed');
  expect(useChat.getState().draft).toBe('');
  expect(useChat.getState().banner).toContain('重新选择');
});
it('列表可清空并显式继续；身份失效后所有原列表操作被阻止', () => {
  const item = {
    clientMessageId: 'queued',
    revision: 3,
    mode: 'queue' as const,
    status: 'queued' as const,
    text: '待发',
    content: { text: '待发' },
  };
  emit({ type: 'followup.state', snapshot: { ...snapshot([item]), paused: true } });
  expect(useChat.getState().clearFollowups(queueId)).toBe(true);
  expect(sent.at(-1)).toEqual({ type: 'followup.clear', queueId });
  expect(useChat.getState().resumeFollowups(queueId)).toBe(true);
  expect(sent.at(-1)).toEqual({ type: 'followup.resume', queueId });
  recover({ type: 'connection.rejected', code: 'owner_missing', message: '失效' });
  const count = sent.length;
  expect(useChat.getState().editFollowup(queueId, item.clientMessageId, '修改')).toBe(false);
  expect(useChat.getState().cancelFollowup(queueId, item.clientMessageId)).toBe(false);
  expect(useChat.getState().clearFollowups(queueId)).toBe(false);
  expect(useChat.getState().resumeFollowups(queueId)).toBe(false);
  expect(sent).toHaveLength(count);
});
it('恢复未发送条目可交换当前草稿并单独管理备份，不覆盖P04待恢复输入', () => {
  emit({
    type: 'followup.state',
    snapshot: snapshot([
      {
        clientMessageId: 'failed',
        revision: 1,
        mode: 'queue',
        status: 'failed',
        text: '旧文字',
        content: { text: '旧文字', model: 'old-model' },
      },
    ]),
  });
  useChat.setState({ draft: '新文字', pendingAttachmentInput: { text: 'P04备份', attachments: [], rejected: true } });
  useChat.getState().restoreFollowup(queueId, 'failed');
  expect(useChat.getState().draft).toBe('旧文字');
  expect(useChat.getState().modelOverrides.codex).toBe('old-model');
  const backup = useChat.getState().draftBackups[0]!;
  useChat.getState().restoreDraftBackup(backup.id);
  expect(useChat.getState().draft).toBe('新文字');
  expect(useChat.getState().pendingAttachmentInput?.text).toBe('P04备份');
  const swapped = useChat.getState().draftBackups[0]!;
  expect(swapped.text).toBe('旧文字');
  useChat.getState().discardDraftBackup(swapped.id);
  expect(useChat.getState().draftBackups).toEqual([]);
  expect(sent).toEqual([]);
});
it('服务器恢复的附件缺少原File时拒绝恢复，未确认错误备份可主动放弃', () => {
  emit({
    type: 'followup.state',
    snapshot: snapshot([
      {
        clientMessageId: 'failed',
        revision: 0,
        mode: 'queue',
        status: 'failed',
        text: '文件',
        content: {
          text: '文件',
          attachments: [{ id: '00000000-0000-4000-8000-000000000003', revision: 'a'.repeat(64) }],
        },
      },
    ]),
  });
  useChat.getState().restoreFollowup(queueId, 'failed');
  expect(useChat.getState().banner).toContain('原文件备份');
  useChat.getState().setDraft('追加错误');
  useChat.getState().sendFollowup('追加错误', 'queue');
  const message = sent.at(-1) as Extract<ClientMessage, { type: 'chat.followup' }>;
  emit({ type: 'followup.error', queueId, clientMessageId: message.clientMessageId, message: '队列已占用' });
  useChat.getState().discardFollowupBackup(queueId, message.clientMessageId);
  expect(useChat.getState().followups[queueId]!.drafts[message.clientMessageId]).toBeUndefined();
  expect(useChat.getState().draft).toBe('追加错误');
});
it('空输入、过大内容、待回执、列表满与离线均保留草稿并拒绝追加', () => {
  running();
  emit({ type: 'followup.state', snapshot: snapshot() });
  expect(useChat.getState().sendFollowup('', 'queue')).toBe(false);
  expect(useChat.getState().sendFollowup('x'.repeat(65_537), 'queue')).toBe(false);
  expect(useChat.getState().sendFollowup('第一条追加', 'queue')).toBe(true);
  expect(useChat.getState().sendFollowup('等回执', 'queue')).toBe(false);
  const message = sent.at(-1) as Extract<ClientMessage, { type: 'chat.followup' }>;
  emit({ type: 'followup.error', queueId, clientMessageId: message.clientMessageId, message: '拒绝' });
  const items = Array.from({ length: 10 }, (_, index) => ({
    clientMessageId: String(index),
    revision: 0,
    mode: 'queue' as const,
    status: 'queued' as const,
    text: '待发',
    content: { text: '待发' },
  }));
  emit({ type: 'followup.state', snapshot: { ...snapshot(items), revision: 2 } });
  expect(useChat.getState().sendFollowup('已满', 'queue')).toBe(false);
  emit({ type: 'followup.state', snapshot: { ...snapshot(), revision: 3 } });
  useChat.setState({ connection: 'closed' });
  expect(useChat.getState().sendFollowup('离线', 'queue')).toBe(false);
  expect(useChat.getState().banner).toContain('断开');
});

it('未知会话的队列快照不会在后台凭空造出草稿条目', () => {
  running();
  const before = Object.keys(useChat.getState().background);
  emit({ type: 'followup.state', snapshot: { ...snapshot(), conversationId: 'gone', sessionId: undefined } });
  expect(Object.keys(useChat.getState().background)).toEqual(before);
  expect(useChat.getState().queueId).toBe(queueId);
});

it('会话身份相同的快照挂回存活视图而不是另建一条', () => {
  running();
  const origin = useChat.getState().conversationId;
  emit({ type: 'followup.state', snapshot: { ...snapshot(), conversationId: 'unknown', revision: 5 } });
  const state = useChat.getState();
  expect(Object.keys(state.background)).toEqual([]);
  expect(state.conversationId).toBe(origin);
  expect(state.queueId).toBe(queueId);
  expect(state.followups[queueId]?.snapshot.revision).toBe(5);
});

it('后台入口只在队列仍有未完成项时保留', () => {
  running();
  const view = useChat.getState();
  const queued = (status: 'queued' | 'accepted', id = 'one'): FollowupSnapshot['items'] => [
    { clientMessageId: id, revision: 0, mode: 'queue', status, text: '待发', content: { text: '待发' } },
  ];
  emit({ type: 'followup.state', snapshot: { ...snapshot(queued('queued')), revision: 2 } });
  expect(queueHasPending(useChat.getState().followups, view)).toBe(true);
  emit({ type: 'followup.state', snapshot: { ...snapshot(queued('accepted')), revision: 3 } });
  expect(queueHasPending(useChat.getState().followups, view)).toBe(false);
});
