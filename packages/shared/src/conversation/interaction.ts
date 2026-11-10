import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));
const value = z.union([
  z.string().max(16_384),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(4096)).max(20),
]);
export const InteractionAnswerSchema = z
  .discriminatedUnion('action', [
    z.strictObject({ action: z.literal('submit'), values: z.record(z.string().max(200), value) }),
    z.strictObject({ action: z.literal('decline') }),
    z.strictObject({ action: z.literal('cancel') }),
  ])
  .refine((answer) => new TextEncoder().encode(JSON.stringify(answer)).byteLength <= 16_384, '答复内容过大');
export type InteractionAnswer = z.infer<typeof InteractionAnswerSchema>;
const baseField = {
  id: identifier,
  label: z.string().min(1).max(2000),
  description: z.string().max(4000).optional(),
  required: z.boolean(),
  secret: z.boolean().optional(),
};
export const InteractionFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...baseField,
    type: z.literal('text'),
    minLength: z.number().int().nonnegative().max(16_384).optional(),
    maxLength: z.number().int().nonnegative().max(16_384).optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
  }),
  z.strictObject({
    ...baseField,
    type: z.literal('number'),
    integer: z.boolean().optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  }),
  z.strictObject({ ...baseField, type: z.literal('boolean') }),
  z.strictObject({
    ...baseField,
    type: z.literal('choice'),
    multiple: z.boolean(),
    allowOther: z.boolean().optional(),
    minSelections: z.number().int().nonnegative().max(20).optional(),
    maxSelections: z.number().int().nonnegative().max(20).optional(),
    options: z
      .array(
        z.strictObject({
          value: z.string().min(1).max(4096),
          label: z.string().min(1).max(2000),
          description: z.string().max(4000).optional(),
        }),
      )
      .min(1)
      .max(20),
  }),
]);
export type InteractionField = z.infer<typeof InteractionFieldSchema>;
const fields = z
  .array(InteractionFieldSchema)
  .max(20)
  .refine((fields) => new Set(fields.map((field) => field.id)).size === fields.length);
const base = { title: z.string().min(1).max(4000), blocking: z.boolean(), source: z.string().max(200).optional() };
export const InteractionSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('questions'), fields: fields.refine((fields) => fields.length <= 4) }),
  z.strictObject({ ...base, kind: z.literal('form'), fields }),
  z.strictObject({
    ...base,
    kind: z.literal('url'),
    url: z
      .url()
      .max(8192)
      .refine((url) => ['http:', 'https:'].includes(new URL(url).protocol)),
  }),
]);
export type InteractionSpec = z.infer<typeof InteractionSpecSchema>;
export type InteractionOwner = { kind: 'turn' | 'session' | 'nativeOperation'; id: string; runtimeId: string };
export type UserInteraction = InteractionSpec & { id: string; owner: InteractionOwner };
export type InteractionResolution = 'submitted' | 'declined' | 'cancelled' | 'completed';
export type InteractionEvent =
  | { type: 'interaction_request'; interaction: UserInteraction }
  | { type: 'interaction_resolved'; id: string; resolution: InteractionResolution };

function textError(field: Extract<InteractionField, { type: 'text' }>, input: unknown): string | undefined {
  if (typeof input !== 'string') return '请输入文字';
  if (field.minLength !== undefined && input.length < field.minLength) return '内容长度不足';
  if (field.maxLength !== undefined && input.length > field.maxLength) return '内容超出长度限制';
  if (!field.format) return;
  const formats = {
    email: [z.email(), '请输入有效邮箱'],
    uri: [z.url(), '请输入有效地址'],
    date: [z.iso.date(), '请输入有效日期'],
    'date-time': [z.iso.datetime({ offset: true }), '请输入有效日期和时间'],
  } as const;
  const [schema, message] = formats[field.format];
  if (!schema.safeParse(input).success) return message;
}
function choiceError(field: Extract<InteractionField, { type: 'choice' }>, input: unknown): string | undefined {
  if (field.multiple ? !Array.isArray(input) : typeof input !== 'string') return '请选择有效选项';
  const values = Array.isArray(input) ? input : [input];
  if (field.minSelections !== undefined && values.length < field.minSelections) return '选择数量不足';
  if (field.maxSelections !== undefined && values.length > field.maxSelections) return '选择数量超过上限';
  if (new Set(values).size !== values.length) return '选项不能重复';
  const allowed = new Set(field.options.map((option) => option.value));
  if (values.some((value) => typeof value !== 'string' || (!field.allowOther && !allowed.has(value))))
    return '请选择有效选项';
}
function fieldError(field: InteractionField, input: unknown): string | undefined {
  if (input === undefined) return field.required ? '此项必填' : undefined;
  if (field.required && isEmpty(input)) return '此项必填';
  if (field.type === 'text') return textError(field, input);
  if (field.type === 'choice') return choiceError(field, input);
  if (field.type === 'boolean') return typeof input === 'boolean' ? undefined : '请选择是或否';
  return numberError(field, input);
}
function isEmpty(value: unknown): boolean {
  return value === '' || (Array.isArray(value) && !value.length);
}
function numberError(field: Extract<InteractionField, { type: 'number' }>, input: unknown): string | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) return '请输入有效数值';
  if (field.integer && !Number.isInteger(input)) return '请输入整数';
  if (field.minimum !== undefined && input < field.minimum) return '数值低于下限';
  if (field.maximum !== undefined && input > field.maximum) return '数值超过上限';
}
/** 网页提示与宿主答复验证共用；未声明字段不能夹带进入原生工具。 */
export function interactionAnswerErrors(spec: InteractionSpec, answer: InteractionAnswer): Record<string, string> {
  if (answer.action !== 'submit') return {};
  if (spec.kind === 'url') return Object.keys(answer.values).length ? { _form: '授权确认不接收表单值' } : {};
  const errors: Record<string, string> = {};
  const known = new Set(spec.fields.map((field) => field.id));
  if (Object.keys(answer.values).some((key) => !known.has(key))) errors._form = '答复包含未知字段';
  for (const field of spec.fields) {
    const error = fieldError(field, answer.values[field.id]);
    if (error) errors[field.id] = error;
  }
  return errors;
}
