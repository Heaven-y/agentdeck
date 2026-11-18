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
    lastSentAt: 2000,
    draft: '',
    background: {},
  });
  expect(listed({ p1: [nativeRow('')] })).toMatchObject([{ title: '帮我做一个图', local: false }]);
  expect(listed({ p1: [nativeRow('原生标题')] })).toMatchObject([{ title: '原生标题' }]);
  expect(listed({ p1: [] })).toMatchObject([{ title: '帮我做一个图', local: true }]);
});
