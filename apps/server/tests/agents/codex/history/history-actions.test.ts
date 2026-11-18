import { afterEach, expect, it, vi } from 'vitest';
import { createCodexHistoryBackend } from '../../../../src/agents/codex/history/history-actions';
import { CodexClient } from '../../../../src/agents/codex/run/client';

afterEach(() => vi.restoreAllMocks());
it('resume载入时历史已被外部追加则拒绝回退，不能删掉预览之外的新轮次', async () => {
  const dir = process.cwd();
  const turns = [{ id: 'first', status: 'completed', items: [{ type: 'userMessage' }] }];
  const request = vi.fn(async (method: string) => {
    if (method === 'thread/resume')
      turns.push({ id: 'external', status: 'completed', items: [{ type: 'userMessage' }] });
    return {
      thread: { id: 'native', cwd: dir, source: 'cli', status: { type: 'idle' }, turns: structuredClone(turns) },
    };
  });
  vi.spyOn(CodexClient, 'start').mockResolvedValue({
    initialize: async () => {},
    request,
    close: async () => {},
  } as unknown as CodexClient);
  const backend = await createCodexHistoryBackend('native', dir);
  await backend.read();
  await backend.inspect('first');
  await expect(backend.execute('first')).rejects.toThrow();
  expect(request.mock.calls.some(([method]) => method === 'thread/revert')).toBe(false);
  await backend.close();
});

it('原生初始化失败必须清理，回退未移除目标时保持未知，缺完整记录拒绝', async () => {
  const close = vi.fn(async () => {}),
    dir = process.cwd();
  const client = {
    initialize: vi.fn(async () => {}),
    close,
    request: vi.fn(async () => ({
      thread: {
        id: 'native',
        cwd: dir,
        source: 'cli',
        status: { type: 'idle' },
        turns: [{ id: 'turn', status: 'completed', items: [{ type: 'userMessage' }], itemsView: 'full' }],
      },
    })),
  };
  vi.spyOn(CodexClient, 'start').mockResolvedValue(client as unknown as CodexClient);
  client.initialize.mockRejectedValueOnce(new Error('initialize failed'));
  await expect(createCodexHistoryBackend('native', dir)).rejects.toThrow('initialize');
  expect(close).toHaveBeenCalledOnce();
  const backend = await createCodexHistoryBackend('native', dir);
  await expect(backend.execute('turn')).rejects.toThrow();
  await backend.inspect('turn');
  expect((await backend.execute('turn')).status).toBe('unknown');
  client.request.mockResolvedValueOnce({
    thread: {
      id: 'native',
      cwd: dir,
      source: 'cli',
      status: { type: 'idle' },
      turns: [{ id: 'turn', status: 'completed', items: [], itemsView: 'summary' }],
    },
  });
  await expect(backend.read()).rejects.toThrow();
  await backend.close();
});

it('Codex只允许完整的主线程用户回合，确认后resume再revert并复核结果', async () => {
  const dir = process.cwd();
  let turns = [
    { id: 'first', status: 'completed', items: [{ type: 'userMessage' }] },
    { id: 'review', status: 'completed', items: [{ type: 'userMessage' }, { type: 'enteredReviewMode' }] },
  ];
  let source: unknown = 'cli';
  const request = vi.fn(async (method: string) => {
    if (method === 'thread/revert') turns = [];
    return { thread: { id: 'native', cwd: dir, source, status: { type: 'idle' }, turns: structuredClone(turns) } };
  });
  const close = vi.fn(async () => {});
  vi.spyOn(CodexClient, 'start').mockResolvedValue({
    initialize: async () => {},
    request,
    close,
  } as unknown as CodexClient);
  const backend = await createCodexHistoryBackend('native', dir);
  expect((await backend.read()).candidates.map((point) => point.id)).toEqual(['first']);
  await expect(backend.inspect('review')).rejects.toThrow();
  source = { subAgent: {} };
  await expect(backend.read()).rejects.toThrow();
  source = 'cli';
  expect(await backend.inspect('first')).toMatchObject({ removesTurns: 2 });
  expect((await backend.execute('first')).status).toBe('completed');
  expect(
    request.mock.calls
      .filter(([method]) => ['thread/resume', 'thread/revert'].includes(method))
      .map(([method]) => method),
  ).toEqual(['thread/resume', 'thread/revert']);
  await backend.close();
  expect(close).toHaveBeenCalledOnce();
});
