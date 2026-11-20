// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  historyItems,
  reduceChat,
  type ChatItem,
} from '../../../../src/features/conversation/model/conversation-events';
import { useChat } from '../../../../src/features/chat/state/chat-store';
import { averageTokenRate } from '../../../../src/features/conversation/model/chat-metrics';
import { filterTrajectory, projectTrajectory } from '../../../../src/features/conversation/trajectory/trajectory-model';
import { LiveTrajectory } from '../../../../src/features/chat/timeline/LiveTrajectory';
import { LiveConversationSurface } from '../../../../src/features/chat/timeline/LiveConversationSurface';
import { TrajectoryView } from '../../../../src/features/conversation/trajectory/TrajectoryView';
import { StatisticsLine } from '../../../../src/features/conversation/timeline/StatisticsLine';
import { ComposerStatus } from '../../../../src/features/chat/composer/ComposerStatus';
import { FollowupQueue } from '../../../../src/features/chat/followups/FollowupQueue';
import { ConversationSidebar } from '../../../../src/app/sidebar/ConversationSidebar';
import { useConversationSidebar } from '../../../../src/app/sidebar/use-conversation-sidebar';
import type { TrajectoryRow } from '../../../../src/features/conversation/trajectory/trajectory-model';

// jsdom 不提供布局测量；这里只替换虚拟滚动宿主，保留真实步骤与右栏交互。
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: TrajectoryRow[];
    itemContent(index: number, row: TrajectoryRow): ReactNode;
  }) => (
    <div>
      {data.map((row, index) => (
        <div key={row.id}>{itemContent(index, row)}</div>
      ))}
    </div>
  ),
}));

beforeEach(() => {
  useChat.setState(useChat.getInitialState(), true);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('按用户轮次分组、保留逐项步骤，不把分叉标识当作执行事件', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'user-one', text: '检查文件' },
    { kind: 'tool', id: 'read', name: 'Read', input: {}, status: 'done' },
    { kind: 'assistant', id: 'answer', text: '已检查', streaming: false },
    { kind: 'fork-point', id: 'point', pointId: 'native-point' },
    { kind: 'user', id: 'user-two', text: '执行命令' },
    { kind: 'tool', id: 'command', name: 'Bash', input: {}, status: 'running' },
  ];
  expect(projectTrajectory(items).map((row) => [row.kind, row.number])).toEqual([
    ['turn', 1],
    ['step', 1],
    ['step', 2],
    ['turn', 2],
    ['step', 1],
  ]);
});

it('独立子代理轨迹只选择自己的步骤，不读取父上下文或改写父选中项', () => {
  useChat.setState({
    inspectedItemId: 'parent-step',
    contextUsage: { source: 'claude_estimate', usedTokens: 600, windowTokens: 200000 },
  });
  const inspect = vi.fn();
  render(
    <TrajectoryView
      items={[{ kind: 'assistant', id: 'child-step', text: '子代理回复', streaming: false }]}
      running={false}
      inspect={inspect}
    />,
  );
  expect(screen.queryByText('最近报告')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看步骤 1：回复 子代理回复' }));
  expect(inspect).toHaveBeenCalledWith('child-step');
  expect(useChat.getState().inspectedItemId).toBe('parent-step');
});

it('没有回复正文时，未确认的结果仍能从本轮轨迹打开详情', async () => {
  const items = historyItems([
    { type: 'user_message', text: '示例请求' },
    { type: 'turn_end', isError: true, outcome: 'unconfirmed' },
  ]);
  useChat.setState({ items });
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: '查看步骤 1：状态 本轮结果待核实' }));
  expect(await screen.findByRole('heading', { name: '步骤详情' })).toBeTruthy();
  expect(screen.getByText(/CLI 返回的完成状态与本轮记录不一致/)).toBeTruthy();
});

it('没有回复正文的恢复状态仍可从待发暂停处打开本轮详情', async () => {
  const items = historyItems([
    { type: 'user_message', text: '示例请求' },
    { type: 'turn_end', isError: true, outcome: 'unconfirmed' },
  ]);
  const conversationId = useChat.getState().conversationId;
  useChat.setState({
    items,
    workspaceId: 'project',
    agent: 'antigravity',
    followups: {
      queue: {
        drafts: {},
        snapshot: {
          queueId: 'queue',
          conversationId,
          workspaceId: 'project',
          agent: 'antigravity',
          revision: 1,
          paused: true,
          canSteer: false,
          reason: '本轮结果尚未确认，待发已暂停。',
          items: [{ clientMessageId: 'next', revision: 0, mode: 'queue', status: 'queued', text: '下一条' }],
        },
      },
    },
  });
  render(<FooterFixture />);
  expect(screen.queryByRole('button', { name: '查看本轮状态' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看待发暂停原因' }));
  expect(await screen.findByRole('heading', { name: '步骤详情' })).toBeTruthy();
  expect(screen.getByText(/CLI 返回的完成状态与本轮记录不一致/)).toBeTruthy();
});

it('速度只配对同范围数据，未知耗时、失败、非有限 token 均隐藏', () => {
  const usage = { source: 'claude' as const, scope: 'turn' as const, outputTokens: 120 };
  const statistics = { scope: 'turn' as const, durationMs: 2000, usage };
  expect(averageTokenRate(statistics)).toBe(60);
  expect(averageTokenRate({ ...statistics, scope: 'step' })).toBeUndefined();
  expect(averageTokenRate({ ...statistics, durationMs: 0 })).toBeUndefined();
  expect(averageTokenRate({ ...statistics, isError: true })).toBeUndefined();
  expect(averageTokenRate({ ...statistics, usage: { ...usage, outputTokens: NaN } })).toBeUndefined();
  render(<StatisticsLine statistics={statistics} />);
  expect(screen.getByText('回合平均 60.0 tok/s')).toBeTruthy();
});

it('生成统计独立显示首段等待与流式速度，不把步骤总耗时当生成时间', () => {
  const items = reduceChat([], {
    type: 'step_usage',
    id: 'step',
    durationMs: 10000,
    usage: { source: 'antigravity', scope: 'step', outputTokens: 25, reasoningOutputTokens: 5 },
    generation: { firstTokenMs: 150, durationMs: 200 },
  });
  const statistics = items.find((item) => item.kind === 'statistics');
  if (!statistics || statistics.kind !== 'statistics') throw new Error('缺少步骤统计');
  render(<StatisticsLine statistics={statistics} />);
  expect(screen.getByText('首段 150 ms')).toBeTruthy();
  expect(screen.getByText('生成 200 ms')).toBeTruthy();
  expect(screen.getByText('生成平均 125.0 tok/s')).toBeTruthy();
  expect(screen.queryByText('步骤平均 2.5 tok/s')).toBeNull();
});

it('角色筛选保留原始顺序和轮次，用户可查看全文，上下文只采用原生报告', async () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'prompt', text: '检查示例目录' },
    { kind: 'tool', id: 'read', name: 'Read', input: { path: 'demo.ts' }, status: 'done' },
    { kind: 'assistant', id: 'reply', text: '目录已检查', streaming: false },
    { kind: 'compaction', id: 'compact', state: { status: 'completed', beforeTokens: 1000, afterTokens: 400 } },
  ];
  const rows = projectTrajectory(items);
  expect(filterTrajectory(rows, 'tool').map((row) => row.id)).toEqual(['turn:prompt', 'step:read']);
  expect(filterTrajectory(rows, 'assistant').map((row) => row.id)).toEqual(['turn:prompt', 'step:reply']);
  expect(filterTrajectory(rows, 'context').map((row) => row.id)).toEqual(['turn:prompt', 'step:compact']);
  useChat.setState({ items, contextUsage: { source: 'codex_native', usedTokens: 400, windowTokens: 200000 } });
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: '用户' }));
  expect(screen.queryByRole('button', { name: /查看步骤/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看用户消息：检查示例目录' }));
  expect(await screen.findByRole('heading', { name: '步骤详情' })).toBeTruthy();
  expect(useChat.getState().inspectedItemId).toBe('prompt');
  fireEvent.click(screen.getByRole('button', { name: '上下文' }));
  expect(screen.getByText('最近报告')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '查看用户消息：检查示例目录' })).toBeNull();
});

function Fixture() {
  const dock = useConversationSidebar();
  const items = useChat((state) => state.items);
  return (
    <>
      <LiveConversationSurface>
        <LiveTrajectory items={items} running />
      </LiveConversationSurface>
      {dock.open && <ConversationSidebar open close={dock.hide} settings={() => undefined} />}
    </>
  );
}

function FooterFixture() {
  const dock = useConversationSidebar();
  return (
    <>
      <ComposerStatus />
      <FollowupQueue focusComposer={() => undefined} />
      {dock.open && <ConversationSidebar open close={dock.hide} settings={() => undefined} />}
    </>
  );
}

it('执行步骤打开现有右栏详情，结果实时更新且审批保留可操作入口', async () => {
  useChat.setState({
    connection: 'open',
    running: true,
    turnId: 'turn',
    items: [
      { kind: 'user', id: 'prompt', text: '检查目录' },
      { kind: 'tool', id: 'command', name: 'Bash', input: { command: 'demo' }, status: 'running', durationMs: 100 },
      { kind: 'permission', id: 'permission', toolName: 'Write', input: { path: 'demo.txt' } },
    ],
  });
  render(<Fixture />);
  expect(screen.queryByRole('complementary')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: /查看步骤 1：命令 demo/ }));
  expect(await screen.findByRole('heading', { name: '步骤详情' })).toBeTruthy();
  expect(screen.getByText(/"command": "demo"/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '批准' }).hasAttribute('disabled')).toBe(false);
  act(() =>
    useChat.setState((state) => ({
      items: state.items.map((item) => (item.kind === 'tool' ? { ...item, output: '执行完成', status: 'done' } : item)),
    })),
  );
  expect(screen.getByText('执行完成')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '收起右侧边栏' }));
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(useChat.getState().inspectedItemId).toBeUndefined();
});
