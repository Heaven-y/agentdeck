import { afterEach, expect, it, vi } from 'vitest';
import { createClaudeRewindBackend } from '../../../../src/agents/claude/history/native-actions';
const mocks = vi.hoisted(() => ({ read: vi.fn(), rewind: vi.fn(), close: vi.fn(), query: vi.fn() }));
vi.mock('../../../../src/agents/claude/history/sessions', () => ({
  createClaudeSessions: () => ({ read: mocks.read }),
}));
vi.mock('../../../../src/agents/claude/run/query', async (original) => ({
  ...(await original<object>()),
  nativeClaudeQuery: mocks.query,
}));
afterEach(() => vi.resetAllMocks());
it('Claude回退读取真实用户检查点，预览只dryRun，执行区分链接跳过且关闭控制实例', async () => {
  mocks.read.mockResolvedValue({
    events: [
      { type: 'user_message', nativeInputId: 'point', text: 'fixture' },
      { type: 'text', delta: '回复' },
      { type: 'user_message', nativeInputId: 'second', text: 'next' },
    ],
  });
  mocks.query.mockReturnValue({ rewindFiles: mocks.rewind, close: mocks.close, async *[Symbol.asyncIterator]() {} });
  mocks.rewind.mockResolvedValue({ canRewind: true, filesChanged: [], insertions: 1, deletions: 1 });
  const backend = createClaudeRewindBackend('native', process.cwd());
  expect((await backend.read()).candidates.map((point) => point.label)).toEqual([
    '第 2 项用户输入之前',
    '第 1 项用户输入之前',
  ]);
  expect(await backend.inspect('point')).toMatchObject({ files: [] });
  expect(mocks.rewind).toHaveBeenLastCalledWith('point', { dryRun: true });
  expect((await backend.execute('point')).status).toBe('completed');
  expect(mocks.rewind).toHaveBeenLastCalledWith('point', { dryRun: false });
  mocks.rewind.mockResolvedValueOnce({ canRewind: true, skippedLinks: 1 });
  expect((await backend.execute('point')).status).toBe('partial');
  mocks.rewind.mockResolvedValue({ canRewind: false });
  await expect(backend.inspect('point')).rejects.toThrow('检查点');
  await expect(backend.execute('point')).rejects.toThrow('检查点');
  await backend.close();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('缺失检查点能力、坏路径列表或控制消费错误均不报告回退成功', async () => {
  mocks.read.mockResolvedValue({ events: [{ type: 'user_message', text: '无原生UUID' }] });
  mocks.query.mockReturnValue({
    close: mocks.close,
    async *[Symbol.asyncIterator]() {
      yield {};
      throw new Error('closed');
    },
  });
  const missing = createClaudeRewindBackend('native', process.cwd());
  expect((await missing.read()).candidates).toEqual([]);
  await expect(missing.inspect('point')).rejects.toThrow('检查点');
  await missing.close();
  mocks.query.mockReturnValue({ rewindFiles: mocks.rewind, close: mocks.close, async *[Symbol.asyncIterator]() {} });
  mocks.rewind.mockResolvedValue({ canRewind: true, filesChanged: [null] });
  const invalid = createClaudeRewindBackend('native', process.cwd());
  await expect(invalid.inspect('point')).rejects.toThrow('检查点');
  await invalid.close();
});
