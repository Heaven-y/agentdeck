import { expect, it, vi } from 'vitest';
import {
  codexCollaboration,
  codexReviewTarget,
  verifyCodexMode,
} from '../../../../src/agents/codex/history/native-actions';

it('显式计划/默认模式才生成原生参数，使用实际模型，不偷偷切换权限或模型', () => {
  expect(codexCollaboration(undefined, { model: 'native' })).toEqual({});
  expect(codexCollaboration('plan', { model: 'native', effort: 'high' })).toEqual({
    collaborationMode: {
      mode: 'plan',
      settings: { model: 'native', reasoning_effort: 'high', developer_instructions: null },
    },
  });
  expect(codexCollaboration('default', { model: 'native' })).toMatchObject({ collaborationMode: { mode: 'default' } });
  expect(() => codexCollaboration('plan', { model: '' })).toThrow('模型');
});

it('只有显式模式读取原生协商目录，未开放的模式拒绝', async () => {
  const client = { request: vi.fn(async () => ({ data: [{ mode: 'default' }] })) };
  await verifyCodexMode(client);
  expect(client.request).not.toHaveBeenCalled();
  await verifyCodexMode(client, 'default');
  await expect(verifyCodexMode(client, 'plan')).rejects.toThrow('未提供');
});
it('原生审查默认目标为未提交改动，显式说明为custom目标而不是普通对话提示', () => {
  expect(codexReviewTarget('')).toEqual({ type: 'uncommittedChanges' });
  expect(codexReviewTarget('核对本轮修改')).toEqual({ type: 'custom', instructions: '核对本轮修改' });
  expect(() => codexReviewTarget('大'.repeat(40_000))).toThrow('过长');
});
