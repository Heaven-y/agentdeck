// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useChat } from '../../../../src/features/chat/state/chat-store';
import { conversationTitle } from '../../../../src/features/chat/state/conversations';
import { useWorkspaceSessions } from '../../../../src/features/sessions/list/workspace-sessions';

beforeEach(() => useChat.setState(useChat.getInitialState(), true));
afterEach(cleanup);

const nativeRow = (title: string) => ({
  agent: 'antigravity' as const,
  sessionId: 'native-1',
  projectId: 'p1',
  title,
  updatedAt: new Date(1000).toISOString(),
  running: false,
});

function listed(state: Parameters<typeof useWorkspaceSessions>[0]) {
  const view = renderHook(() => useWorkspaceSessions(state));
  const rows = view.result.current.p1 ?? [];
  view.unmount();
  return rows;
}

it('没有原生标题时只由已发送的首条消息推导，未发送的草稿不参与', () => {
  expect(conversationTitle({ title: undefined, items: [] })).toBe('新会话');
  expect(conversationTitle({ title: undefined, items: [{ kind: 'user', id: 'u1', text: '帮我画个图' }] })).toBe(
    '帮我画个图',
  );
  expect(conversationTitle({ title: '原生标题', items: [] })).toBe('原生标题');
});

it('原生标题为空时不顶掉本地推导的标题', () => {
  useChat.setState({
    conversationId: 'conv-1',
    workspaceId: 'p1',
    agent: 'antigravity',
    sessionId: 'native-1',
    title: undefined,
    items: [{ kind: 'user', id: 'u1', text: '帮我做一个图' }],
    // 打开原生历史不会在本页发消息，也就没有 lastSentAt。
    lastSentAt: undefined,
    draft: '',
    background: {},
  });
  expect(listed({ p1: [nativeRow('')] })).toMatchObject([{ title: '帮我做一个图', local: false }]);
  expect(listed({ p1: [nativeRow('原生标题')] })).toMatchObject([{ title: '原生标题' }]);
  expect(listed({ p1: [] })).toMatchObject([{ title: '帮我做一个图', local: true }]);
});

it('关闭新会话标签后的草稿仍归入工作区，运行任务不依赖是否选中', () => {
  useChat.getState().selectWorkspace('p1');
  useChat.getState().setDraft('待继续的草稿');
  const draftId = useChat.getState().conversationId;
  useChat.getState().closeConversationTab(draftId);
  expect(listed({ p1: [] })).toMatchObject([{ conversationId: draftId, local: true }]);
  useChat.setState({ running: true, pendingClientTurnId: 'turn', workspaceId: 'p1' });
  expect(listed({ p1: [] }).some((row) => row.running)).toBe(true);
});
