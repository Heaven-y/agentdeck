import { expect, it } from 'vitest';
import { claudeQuestion, codexQuestion, nativeElicitation } from '../../src/agents/common/user-interactions';
it('Claude多选与自由回答映射到原题，Codex按原生问题ID返回数组', () => {
  const claude = claudeQuestion({
    questions: [
      {
        question: '选择功能',
        header: '功能',
        multiSelect: true,
        options: [
          { label: 'A', description: '选项A' },
          { label: 'B', description: '选项B' },
        ],
      },
    ],
  });
  expect(claude.spec.kind).toBe('questions');
  expect(claude.answer({ action: 'submit', values: { q0: ['A', '自填'] } })).toEqual({
    answers: { 选择功能: 'A, 自填' },
  });
  const codex = codexQuestion({
    isBlocking: false,
    questions: [{ id: 'native-id', header: '名字', question: '输入名字', isSecret: true, options: null }],
  });
  expect(codex.spec.blocking).toBe(false);
  expect(codex.spec.kind === 'questions' && codex.spec.fields[0]?.secret).toBe(true);
  expect(codex.answer({ action: 'submit', values: { q0: 'value' } })).toEqual({
    answers: { 'native-id': { answers: ['value'] } },
  });
  expect(codex.answer({ action: 'cancel' })).toEqual({ answers: {} });
});
it('MCP与ACP表单保留原生枚举值及约束，秘密默认值不进入展示', () => {
  const form = nativeElicitation({
    mode: 'form',
    message: '选择',
    requestedSchema: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          oneOf: [
            { const: '1', title: 'A' },
            { const: '2', title: 'B' },
          ],
        },
        count: { type: 'integer', minimum: 1, maximum: 5 },
        key: { type: 'string', format: 'password', default: 'private-secret' },
      },
      required: ['choice', 'count'],
    },
  });
  expect(JSON.stringify(form.spec)).not.toContain('private-secret');
  expect(form.answer({ action: 'submit', values: { f0: '2', f1: 3, f2: 'secret' } })).toEqual({
    action: 'accept',
    content: { choice: '2', count: 3, key: 'secret' },
  });
  expect(form.answer({ action: 'decline' })).toEqual({ action: 'decline' });
});
it('不认识的组合schema、正则约束和非http授权URL拒绝而不降级丢条件', () => {
  for (const property of [
    { type: 'string', pattern: 'evil' },
    { type: 'object', properties: {} },
    { $ref: '#/secret' },
  ])
    expect(() =>
      nativeElicitation({
        mode: 'form',
        message: '表单',
        requestedSchema: { type: 'object', properties: { value: property } },
      }),
    ).toThrow();
  expect(() => nativeElicitation({ mode: 'url', message: '授权', url: 'file:///private' })).toThrow();
  const link = nativeElicitation({ mode: 'url', message: '授权', url: 'https://example.test/login' });
  expect(link.answer({ action: 'submit', values: {} })).toEqual({ action: 'accept' });
});
it('拒绝畸形原生字段约束而不是静默丢弃', () => {
  for (const property of [
    { type: 'number', minimum: '1' },
    { type: 'string', maxLength: null },
    { type: 'array', items: { type: 'number', enum: ['a'] } },
    { type: 'array', items: { type: 'string', enum: ['a'] }, uniqueItems: false },
    { type: 'string', enum: ['a'], oneOf: [{ const: 'b' }] },
    { type: 'string', minLength: 4, maxLength: 2 },
  ])
    expect(() =>
      nativeElicitation({ mode: 'form', requestedSchema: { type: 'object', properties: { value: property } } }),
    ).toThrow();
  for (const extra of [{ required: 'value' }, { required: [2] }, { additionalProperties: { type: 'string' } }])
    expect(() =>
      nativeElicitation({
        mode: 'form',
        requestedSchema: { type: 'object', properties: { value: { type: 'string' } }, ...extra },
      }),
    ).toThrow();
});
