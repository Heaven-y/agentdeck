import { expect, it } from 'vitest';
import { ClaudeEventMapper } from '../../../../src/agents/claude/run/mapper';
it('逐条响应模型取自模型消息，实时与历史一致，不沿用配置或上轮型号', () => {
  const mapper = new ClaudeEventMapper();
  mapper.map({ type: 'system', subtype: 'init', model: 'configured', session_id: 's' });
  mapper.map({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', model: 'actual-model' } } });
  expect(
    mapper.map({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '回复' } },
    }),
  ).toEqual([{ type: 'text', delta: '回复', responseModel: 'actual-model' }]);
  expect(
    mapper.mapHistory({
      type: 'assistant',
      message: { model: 'historical-model', content: [{ type: 'text', text: '历史' }] },
    }),
  ).toEqual([{ type: 'text', delta: '历史', responseModel: 'historical-model' }]);
  mapper.beginTurn();
  expect(
    mapper.map({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '未知' } },
    }),
  ).toEqual([{ type: 'text', delta: '未知' }]);
  expect(
    mapper.mapHistory({
      type: 'assistant',
      message: { model: '<synthetic>', content: [{ type: 'text', text: '占位' }] },
    }),
  ).toEqual([{ type: 'text', delta: '占位' }]);
});
