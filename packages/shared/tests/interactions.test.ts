import { expect, it } from 'vitest';
import {
  InteractionAnswerSchema,
  InteractionSpecSchema,
  interactionAnswerErrors,
  type InteractionField,
  type InteractionSpec,
} from '../src/conversation/interaction';
const check = (field: InteractionField, value: unknown) =>
  interactionAnswerErrors({ kind: 'form', title: '资料', blocking: true, fields: [field] }, {
    action: 'submit',
    values: { value },
  } as Parameters<typeof interactionAnswerErrors>[1]);
const base = { id: 'value', label: '字段', required: true };
it('表单按声明约束校验文字格式、数值边界和布尔，不因可选字段绕过约束', () => {
  const cases: Array<[InteractionField, unknown, unknown]> = [
    [{ ...base, type: 'text', minLength: 2, maxLength: 4 }, '中', '中文'],
    [{ ...base, type: 'text', maxLength: 4 }, 'oversize', '好'],
    [{ ...base, type: 'text', format: 'email' }, 'bad', 'fixture@example.test'],
    [{ ...base, type: 'text', format: 'uri' }, 'bad', 'https://example.test'],
    [{ ...base, type: 'text', format: 'date' }, '2026-02-30', '2026-11-11'],
    [{ ...base, type: 'text', format: 'date-time' }, 'bad', '2026-11-11T00:00:00Z'],
    [{ ...base, type: 'number', integer: true, minimum: 1, maximum: 3 }, 1.5, 2],
    [{ ...base, type: 'number', minimum: 1, maximum: 3 }, 0, 1],
    [{ ...base, type: 'number', minimum: 1, maximum: 3 }, 4, 3],
    [{ ...base, type: 'number' }, '2', 2],
    [{ ...base, type: 'boolean' }, 'true', false],
  ];
  for (const [field, invalid, valid] of cases) {
    expect(check(field, invalid)).toHaveProperty('value');
    expect(check(field, valid)).toEqual({});
  }
  expect(check({ ...base, type: 'text' }, 2)).toHaveProperty('value');
  expect(check({ ...base, type: 'text', required: false, minLength: 2 }, '')).toHaveProperty('value');
  expect(check({ ...base, type: 'text', required: false }, undefined)).toEqual({});
  expect(check({ ...base, type: 'text' }, undefined)).toHaveProperty('value');
});
it('选项必须属于原生声明，多选数目和重复值有效约束，自由回答须明确允许', () => {
  const field: InteractionField = {
    ...base,
    type: 'choice',
    multiple: true,
    minSelections: 1,
    maxSelections: 2,
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  };
  for (const invalid of ['a', [], ['a', 'a'], ['c'], ['a', 'b', 'c']])
    expect(check(field, invalid)).toHaveProperty('value');
  expect(check(field, ['a', 'b'])).toEqual({});
  expect(check({ ...field, required: false }, [])).toHaveProperty('value');
  expect(check({ ...field, multiple: false }, ['a'])).toHaveProperty('value');
  expect(check({ ...field, multiple: false, allowOther: true }, '自填')).toEqual({});
});
it('拒绝额外字段与过大答复，取消无答案，URL确认不能夹带数据', () => {
  const spec: InteractionSpec = { kind: 'form', title: '资料', blocking: true, fields: [] };
  expect(interactionAnswerErrors(spec, { action: 'submit', values: { unknown: 'value' } })).toHaveProperty('_form');
  expect(interactionAnswerErrors(spec, { action: 'cancel' })).toEqual({});
  const url: InteractionSpec = { kind: 'url', title: '授权', blocking: true, url: 'https://example.test' };
  expect(interactionAnswerErrors(url, { action: 'submit', values: {} })).toEqual({});
  expect(interactionAnswerErrors(url, { action: 'submit', values: { key: 'value' } })).toHaveProperty('_form');
  expect(InteractionAnswerSchema.safeParse({ action: 'submit', values: { a: '中'.repeat(7000) } }).success).toBe(false);
  expect(
    InteractionSpecSchema.safeParse({
      ...spec,
      fields: [
        { ...base, type: 'text' },
        { ...base, type: 'text' },
      ],
    }).success,
  ).toBe(false);
});
