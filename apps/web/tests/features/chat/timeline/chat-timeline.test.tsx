// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { forwardRef, StrictMode, useImperativeHandle, type ReactNode, type Ref } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatTimeline } from '../../../../src/features/chat/timeline/ChatTimeline';
import { historyItems, type ChatItem } from '../../../../src/features/chat/state/chat-reducer';
import { useChat } from '../../../../src/features/chat/state/chat-store';

const host: {
  scroll: ReturnType<typeof vi.fn>;
  follow: ReturnType<typeof vi.fn>;
  props: Record<string, unknown>;
  navigation: Record<string, unknown>;
} = vi.hoisted(() => ({ scroll: vi.fn(), follow: vi.fn(), props: {}, navigation: {} }));
// jsdom 无布局测量，只替换虚拟列表宿主；索引投影、导航和跟随逻辑仍用真实组件。
vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function Host(props: Record<string, unknown>, ref) {
    useImperativeHandle(ref, () =>
      props['aria-label'] === '对话内容'
        ? { scrollToIndex: host.scroll, autoscrollToBottom: host.follow }
        : { scrollIntoView: vi.fn(), scrollToIndex: vi.fn() },
    );
    if (props['aria-label'] === '对话内容') host.props = props;
    else host.navigation = props;
    const data = props.data as unknown[];
    const renderItem = props.itemContent as (index: number, item: unknown) => ReactNode;
    return (
      <div ref={props.scrollerRef as Ref<HTMLDivElement> | undefined}>
        {data.map((item, index) => (
          <div key={index}>{renderItem(index, item)}</div>
        ))}
      </div>
    );
  }),
}));
afterEach(() => {
  cleanup();
  useChat.setState(useChat.getInitialState(), true);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it('结果未确认只留在过程详情，两轮回复不插入红条且普通错误仍可见', () => {
  const items = historyItems([
    { type: 'user_message', text: '第一轮' },
    { type: 'text', delta: '第一条回复' },
    { type: 'turn_end', isError: true, outcome: 'unconfirmed' },
    { type: 'user_message', text: '第二轮' },
    { type: 'text', delta: '第二条回复' },
    { type: 'turn_end', isError: true, outcome: 'unconfirmed' },
    { type: 'error', message: '本轮明确错误' },
  ]);
  expect(items.filter((item) => item.kind === 'turn-status')).toHaveLength(2);
  render(<ChatTimeline items={items} running={false} />);
  expect(screen.getByText('第一条回复')).toBeTruthy();
  expect(screen.getByText('第二条回复')).toBeTruthy();
  expect(screen.queryByText(/原生结果包含无法确认归属的错误/)).toBeNull();
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByText('本轮明确错误')).toBeTruthy();
});

it('只读错误关闭后虚拟列表重新挂载仍隐藏，且不影响主会话同编号错误', () => {
  const parent = [{ kind: 'error' as const, id: 'error-0', message: '主会话错误' }];
  const child: ChatItem = { kind: 'error', id: 'error-0', message: '只读错误' };
  useChat.setState({ items: parent });
  const view = render(<ChatTimeline items={[child]} running={false} />);

  fireEvent.click(screen.getByRole('button', { name: '关闭这条错误' }));
  expect(screen.queryByText('只读错误')).toBeNull();
  expect(useChat.getState().items).toEqual(parent);
  view.rerender(<ChatTimeline items={[]} running={false} />);
  view.rerender(<ChatTimeline items={[child]} running={false} />);
  expect(screen.queryByText('只读错误')).toBeNull();
});

it('会话切换后关闭当前错误，不影响后台会话的同编号错误', () => {
  useChat.setState({
    workspaceId: 'project',
    items: [{ kind: 'error', id: 'error-0', message: '第一条会话错误' }],
  });
  const first = useChat.getState().conversationId;
  useChat.getState().newSession('codex');
  useChat.setState({ items: [{ kind: 'error', id: 'error-0', message: '第二条会话错误' }] });

  function CurrentTimeline() {
    const items = useChat((state) => state.items);
    return <ChatTimeline items={items} running={false} />;
  }
  render(<CurrentTimeline />);
  fireEvent.click(screen.getByRole('button', { name: '关闭这条错误' }));
  expect(useChat.getState().items).toEqual([]);
  expect(useChat.getState().background[first]?.items).toMatchObject([{ message: '第一条会话错误' }]);

  act(() => useChat.getState().openConversation(first));
  expect(screen.getByText('第一条会话错误')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭这条错误' }));
  expect(useChat.getState().items).toEqual([]);
});

it('严格模式下按实际视口高亮消息，不把上方预渲染条目当作当前位置', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.dataset.chatIndex === '0' ? -100 : this.dataset.chatIndex === '2' ? 300 : 100;
    return { top, bottom: top + 100, height: 100, left: 0, right: 600, width: 600, x: 0, y: top, toJSON() {} };
  });
  render(
    <StrictMode>
      <ChatTimeline
        running={false}
        items={[
          { kind: 'user', id: 'one', text: '屏幕上方的问题' },
          { kind: 'user', id: 'two', text: '当前可见的问题' },
          { kind: 'user', id: 'three', text: '屏幕下方的问题' },
        ]}
      />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '跳转到第 2 条消息：当前可见的问题' }).getAttribute('aria-current')).toBe(
      'true',
    ),
  );
  expect(
    screen.getByRole('button', { name: '跳转到第 1 条消息：屏幕上方的问题' }).getAttribute('aria-current'),
  ).toBeNull();
});

it('用户刻度按工具合并后的真实行定位，主动跳转期间不被流式跟随拉回，回底部后恢复', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', text: '先检查目录' },
    { kind: 'tool', id: 't1', name: 'Read', input: {}, status: 'done' },
    { kind: 'tool', id: 't2', name: 'Read', input: {}, status: 'done' },
    { kind: 'assistant', id: 'a1', text: '已检查', streaming: false },
    { kind: 'user', id: 'u2', text: '再运行示例' },
    { kind: 'assistant', id: 'a2', text: '执行中', streaming: true },
  ];
  const view = render(<ChatTimeline items={items} running />);
  const navigation = within(screen.getByRole('navigation', { name: '用户消息导航' }));
  fireEvent.click(navigation.getByRole('button', { name: '跳转到第 2 条消息：再运行示例' }));
  expect(host.scroll).toHaveBeenLastCalledWith({ index: 3, align: 'start', behavior: 'auto' });
  host.follow.mockClear();
  view.rerender(
    <ChatTimeline items={[...items, { kind: 'assistant', id: 'a3', text: '更多输出', streaming: true }]} running />,
  );
  expect(host.follow).not.toHaveBeenCalled();
  expect((host.props.followOutput as (bottom: boolean) => unknown)(true)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '回到底部' }));
  expect(host.scroll).toHaveBeenLastCalledWith({ index: 'LAST', align: 'end', behavior: 'auto' });
  act(() => (host.props.atBottomStateChange as (bottom: boolean) => void)(true));
  view.rerender(<ChatTimeline items={[...items]} running />);
  expect(host.follow).toHaveBeenCalledOnce();
  // 当前键盘索引滚出刻度的虚拟窗口后，仍有可见的 Tab 入口。
  act(() => {
    (host.props.rangeChanged as (range: unknown) => void)({ startIndex: 0, endIndex: 2 });
    (host.navigation.rangeChanged as ((range: unknown) => void) | undefined)?.({ startIndex: 0, endIndex: 0 });
  });
  expect(navigation.getByRole('button', { name: '跳转到第 1 条消息：先检查目录' }).tabIndex).toBe(0);
});
