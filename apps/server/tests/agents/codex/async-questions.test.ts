import { expect, it } from 'vitest';
import {
  codexAsyncQuestion,
  codexAsyncAnswerText,
  markAnsweredQuestions,
} from '../../../src/agents/codex/async-questions';
import { CodexEventMapper } from '../../../src/agents/codex/mapper';
const item = {
  type: 'agentMessage',
  id: 'question',
  delivery: 'async',
  questions: [{ title: '选择实施范围', options: ['最小修改', '全部完善'] }, { title: '补充约束' }],
};
it('异步问题采用稳定原生消息身份与非阻塞表单，回答仍是追加文字输入', () => {
  const question = codexAsyncQuestion(item, 'session')!;
  expect(question).toMatchObject({
    messageId: 'question',
    sessionId: 'session',
    spec: {
      kind: 'questions',
      blocking: false,
      fields: [
        { id: 'q0', type: 'choice', allowOther: true },
        { id: 'q1', type: 'text' },
      ],
    },
  });
  const answer = codexAsyncAnswerText(question, { action: 'submit', values: { q0: '全部完善', q1: '不升级版本' } });
  expect(answer).toContain('选择实施范围：全部完善');
  expect(answer).toContain('补充约束：不升级版本');
  expect(() => codexAsyncAnswerText(question, { action: 'submit', values: { q0: '全部完善' } })).toThrow('回答');
  expect(() => codexAsyncAnswerText(question, { action: 'cancel' })).toThrow('回答');
});
it('流式正文与最终问题卡片不互相吞掉，历史根据原生回答标记已答且稳定身份去重', () => {
  const mapper = new CodexEventMapper({ sessionId: 'session' });
  mapper.map('item/agentMessage/delta', { itemId: item.id, delta: '请补充' });
  const events = mapper.map('item/completed', { item: { ...item, text: '请补充' } });
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe('async_question');
  expect(mapper.map('item/completed', { item })).toEqual([]);
  const text = codexAsyncAnswerText(codexAsyncQuestion(item, 'session')!, {
    action: 'submit',
    values: { q0: '最小修改', q1: '保留设置' },
  });
  expect(markAnsweredQuestions([...events, { type: 'user_message', text }])[0]).toMatchObject({ answered: true });
  expect(markAnsweredQuestions([...events, { type: 'user_message', text: '不同回答' }])[0]).not.toHaveProperty(
    'answered',
  );
});
it('未知、过量或格式不完整的异步问题不制造可回答卡片，由原文本保留信息', () => {
  expect(codexAsyncQuestion(item, undefined)).toBeUndefined();
  expect(codexAsyncQuestion({ ...item, delivery: 'sync' }, 'session')).toBeUndefined();
  expect(codexAsyncQuestion({ ...item, questions: [] }, 'session')).toBeUndefined();
  expect(
    codexAsyncQuestion({ ...item, questions: Array.from({ length: 5 }, () => ({ title: '问题' })) }, 'session'),
  ).toBeUndefined();
  expect(codexAsyncQuestion({ ...item, questions: [{ title: '问题', options: [42] }] }, 'session')).toBeUndefined();
  expect(
    codexAsyncQuestion({ ...item, questions: [{ title: '问题', options: ['重复', '重复'] }] }, 'session'),
  ).toBeUndefined();
});
