// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { modelSettingsApi } from '../../../src/features/settings/model-settings-api';
import { queryClient } from '../../../src/lib/query-client';
import { ComposerStatus, latestComposerStatistics } from '../../../src/features/chat/ComposerStatus';
import { useChat } from '../../../src/features/chat/chat-store';
import { historyItems, type ChatItem } from '../../../src/features/chat/chat-reducer';
import { StatisticsLine } from '../../../src/features/chat/StatisticsLine';
import { antigravityHistory } from '../../../../server/src/agents/antigravity/history';

const statistics: Extract<ChatItem, { kind: 'statistics' }> = {
  kind: 'statistics',
  id: 'stats-one',
  scope: 'turn',
  durationMs: 2000,
  usage: { source: 'claude', scope: 'turn', inputTokens: 300, outputTokens: 120 },
};
beforeEach(() => useChat.setState(useChat.getInitialState(), true));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

it('仅显示当前用户轮次的已完成统计，运行中或新轮缺值不沿用旧速度', () => {
  const first: ChatItem[] = [{ kind: 'user', id: 'one', text: '第一轮' }, statistics];
  expect(latestComposerStatistics(first, false)).toBe(statistics);
  expect(latestComposerStatistics(first, true)).toBeUndefined();
  expect(latestComposerStatistics([...first, { kind: 'user', id: 'two', text: '第二轮' }], false)).toBeUndefined();
  const step = {
    ...statistics,
    id: 'step-two',
    scope: 'step' as const,
    usage: { ...statistics.usage!, scope: 'step' as const },
  };
  expect(latestComposerStatistics([...first, { kind: 'user', id: 'two', text: '第二轮' }, step], false)).toBe(step);
});

function antigravityTurn(outcome: 'success' | 'error' | 'cancelled' | 'interrupted') {
  const done = 'CORTEX_STEP_STATUS_DONE';
  const tail =
    outcome === 'error'
      ? [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: done,
            errorMessage: { shouldShowUser: true, error: { userErrorMessage: '示例错误' } },
          },
        ]
      : outcome === 'success'
        ? []
        : [
            {
              type: 'CORTEX_STEP_TYPE_NEW_ACTIVITY',
              status: outcome === 'cancelled' ? 'CORTEX_STEP_STATUS_CANCELED' : 'CORTEX_STEP_STATUS_INTERRUPTED',
            },
          ];
  return [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: done, userInput: { query: '示例请求' } },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: done,
      plannerResponse: { response: '示例回复' },
      metadata: {
        createdAt: '2026-03-01T04:00:00Z',
        finishedGeneratingAt: '2026-03-01T04:00:02Z',
        modelUsage: { inputTokens: '100', outputTokens: '20' },
      },
    },
    ...tail,
  ];
}

it.each([
  ['失败', 'error'],
  ['取消', 'cancelled'],
  ['中断', 'interrupted'],
] as const)('历史回复步骤完成后本轮%s：页脚隐藏速度，步骤统计保留', (_label, outcome) => {
  const events = antigravityHistory({ steps: antigravityTurn(outcome) });
  expect(events.findLast((event) => event.type === 'turn_end')).toMatchObject({ isError: true });
  expect(events.filter((event) => event.type === 'error')).toHaveLength(outcome === 'error' ? 1 : 0);
  const items = historyItems(events);
  const step = items.find((item) => item.kind === 'statistics' && item.scope === 'step');
  if (!step || step.kind !== 'statistics') throw new Error('缺少步骤统计');
  useChat.setState({ items: items.filter((item) => item.kind !== 'error') });
  render(
    <>
      <ComposerStatus />
      <StatisticsLine statistics={step} />
    </>,
  );
  const footer = screen.getByRole('button', { name: '本轮统计详情' });
  expect(footer.textContent).toContain('— tok/s');
  expect(footer.getAttribute('title')).toBe('本轮未成功完成，不计算平均速度');
  expect(screen.getByText('步骤平均 10.0 tok/s')).toBeTruthy();
});

it('历史失败轮不影响下一成功轮的页脚速度', () => {
  const events = antigravityHistory({ steps: [...antigravityTurn('error'), ...antigravityTurn('success')] });
  const items = historyItems(events);
  useChat.setState({ items });
  render(<ComposerStatus />);
  expect(screen.getByRole('button', { name: '本轮统计详情' }).textContent).toContain('10.0 tok/s');
});

it('历史工具取消后仍有完整回复时，按成功回合显示页脚速度', () => {
  const [user, response] = antigravityTurn('success');
  const cancelled = { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_CANCELED' };
  const events = antigravityHistory({ steps: [user, cancelled, response] });
  expect(events.findLast((event) => event.type === 'turn_end')).toMatchObject({ isError: false });
  expect(events.some((event) => event.type === 'error')).toBe(false);
  useChat.setState({ items: historyItems(events) });
  render(<ComposerStatus />);
  expect(screen.getByRole('button', { name: '本轮统计详情' }).textContent).toContain('10.0 tok/s');
});

it('取消后的空回复不算恢复，既有错误也不被后续完整回复抹除', () => {
  const [user, response] = antigravityTurn('success');
  const cancelled = { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_CANCELED' };
  const failure = {
    type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
    status: 'CORTEX_STEP_STATUS_DONE',
    errorMessage: { shouldShowUser: true, error: { userErrorMessage: '示例错误' } },
  };
  const empty = { ...response, plannerResponse: { response: '  ' } };
  for (const steps of [
    [user, cancelled, empty],
    [user, failure, cancelled, response],
  ]) {
    const events = antigravityHistory({ steps });
    expect(events.findLast((event) => event.type === 'turn_end')).toMatchObject({ isError: true });
  }
});

it('底部摘要保留上下文与 tok/s，token 明细按需展开，运行中隐藏旧统计', async () => {
  useChat.setState({
    items: [statistics],
    contextUsage: { source: 'claude_estimate', usedTokens: 1000, windowTokens: 20000 },
  });
  render(<ComposerStatus />);
  expect(screen.getByRole('group', { name: '会话统计' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '上下文用量' })).toBeTruthy();
  expect(
    Array.from(screen.getByRole('group', { name: '会话统计' }).querySelectorAll('button')).map((button) =>
      button.getAttribute('aria-label'),
    ),
  ).toEqual(['本轮统计详情', '上下文用量']);
  expect(screen.getByText('60.0 tok/s')).toBeTruthy();
  expect(screen.queryByText('输入 300')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '本轮统计详情' }));
  expect(await screen.findByRole('dialog', { name: '本轮统计详情' })).toBeTruthy();
  expect(screen.getByText('输入 300')).toBeTruthy();
  act(() => useChat.setState({ running: true }));
  expect(screen.getByRole('button', { name: '本轮统计详情' }).textContent).toContain('— tok/s');
  expect(screen.queryByText('60.0 tok/s')).toBeNull();
});

it('没有原生统计时固定显示未知值，不伪造零速与窗口', () => {
  render(<ComposerStatus />);
  expect(screen.getByText('— tok/s')).toBeTruthy();
  expect(screen.getByText('上下文 —')).toBeTruthy();
  expect(screen.queryByText('0.0 tok/s')).toBeNull();
});

it('历史压缩完成不冒充当前状态，上下文面板只保留当前用量', async () => {
  useChat.setState({ compaction: { status: 'completed', trigger: 'auto', beforeTokens: 500, afterTokens: 100 } });
  render(<ComposerStatus />);
  const button = screen.getByRole('button', { name: '上下文用量' });
  expect(button.textContent).toContain('上下文 —');
  expect(screen.queryByText(/压缩已完成/)).toBeNull();
  fireEvent.click(button);
  await screen.findByRole('dialog', { name: '上下文用量详情' });
  expect(screen.queryByText('压缩已完成 · 自动')).toBeNull();
  act(() => useChat.setState({ contextUsage: { source: 'codex_native', usedTokens: 100, windowTokens: 200000 } }));
  expect(button.textContent).toContain('100 / 200,000');
  expect(button.textContent).not.toContain('压缩');
});

it('Antigravity 没有用量报告时说明是原生未提供，而不是笼统的空态', async () => {
  useChat.setState({ agent: 'antigravity', contextUsage: undefined });
  render(<ComposerStatus />);
  fireEvent.click(screen.getByRole('button', { name: '上下文用量' }));
  expect(await screen.findByText(/Antigravity 尚未报告上下文用量/)).toBeTruthy();
});

it('其他 CLI 保持原有的空态文案', async () => {
  useChat.setState({ agent: 'claude', contextUsage: undefined });
  render(<ComposerStatus />);
  fireEvent.click(screen.getByRole('button', { name: '上下文用量' }));
  expect(await screen.findByText('此会话尚无可用的上下文用量与窗口报告。')).toBeTruthy();
});

it('Antigravity 的窗口标明属于哪个模型，不让人误以为是设置里填的值', async () => {
  useChat.setState({
    agent: 'antigravity',
    actualModel: 'Gemini 4 Carbon (High)',
    contextUsage: { source: 'antigravity_estimate', usedTokens: 234848, windowTokens: 256000 },
  });
  render(<ComposerStatus />);
  fireEvent.click(screen.getByRole('button', { name: '上下文用量' }));
  expect(await screen.findByText(/模型：Gemini 4 Carbon \(High\)/)).toBeTruthy();
  expect(screen.getByText(/窗口按该模型的原生配置/)).toBeTruthy();
});

it('打开旧会话使用原生当前窗口，模型改变后刷新，运行中保留启动窗口', async () => {
  const read = vi
    .spyOn(modelSettingsApi, 'contextWindow')
    .mockResolvedValue({ model: 'Current', windowTokens: 1000000 });
  useChat.setState({
    workspaceId: 'project',
    sessionId: 'old-session',
    agent: 'antigravity',
    contextUsage: { source: 'antigravity_estimate', usedTokens: 74994, windowTokens: 256000, percentage: 29.3 },
  });
  render(<ComposerStatus />);
  expect(await screen.findByText('上下文 74,994 / 1,000,000')).toBeTruthy();
  expect(screen.getByLabelText('上下文占用 7.5%')).toBeTruthy();
  act(() => useChat.setState({ running: true, contextWindow: { model: 'Current', windowTokens: 1000000 } }));
  read.mockResolvedValue({ model: 'Current', windowTokens: 200000 });
  await act(() => queryClient.invalidateQueries({ queryKey: ['model-context-window'] }));
  expect(screen.getByText('上下文 74,994 / 1,000,000')).toBeTruthy();
  act(() => useChat.setState({ running: false }));
  expect(await screen.findByText('上下文 74,994 / 200,000')).toBeTruthy();
  read.mockResolvedValue({ model: 'Unknown' });
  act(() => useChat.getState().setModel('Unknown'));
  expect(await screen.findByText('上下文 74,994 / —')).toBeTruthy();
  expect(screen.queryByLabelText('上下文占用 29.3%')).toBeNull();
});

it('用量自带模型时以原生报告的为准', async () => {
  useChat.setState({
    agent: 'antigravity',
    actualModel: 'Gemini 4 Carbon (High)',
    contextUsage: {
      source: 'antigravity_estimate',
      usedTokens: 100,
      windowTokens: 200,
      model: 'Gemini 4 Argon (High)',
    },
  });
  render(<ComposerStatus />);
  fireEvent.click(screen.getByRole('button', { name: '上下文用量' }));
  expect(await screen.findByText(/模型：Gemini 4 Argon \(High\)/)).toBeTruthy();
  expect(screen.queryByText(/模型：Gemini 4 Carbon/)).toBeNull();
});

it('新建内置会话绑定原生 ID 或编辑下轮模型时保留本轮窗口，空闲读取失败不沿用旧窗口', async () => {
  const read = vi
    .spyOn(modelSettingsApi, 'contextWindow')
    .mockResolvedValue({ model: 'Builtin', windowTokens: 1048576 });
  useChat.setState({
    workspaceId: 'project',
    agent: 'antigravity',
    contextUsage: { source: 'antigravity_estimate', usedTokens: 1000 },
  });
  render(<ComposerStatus />);
  expect(await screen.findByText('上下文 1,000 / 1,048,576')).toBeTruthy();
  act(() => useChat.setState({ running: true, runningInput: { text: '示例', attachments: [], model: '' } }));
  act(() => useChat.setState({ sessionId: 'native-new' }));
  expect(screen.getByText('上下文 1,000 / 1,048,576')).toBeTruthy();
  act(() => useChat.getState().setModel('next-model'));
  expect(screen.getByText('上下文 1,000 / 1,048,576')).toBeTruthy();
  read.mockRejectedValue(new Error('同名模型冲突'));
  act(() => useChat.setState({ running: false, modelOverrides: { claude: '', codex: '', antigravity: '' } }));
  await act(() => queryClient.invalidateQueries({ queryKey: ['model-context-window'] }));
  expect(await screen.findByText('上下文 1,000 / —')).toBeTruthy();
});
