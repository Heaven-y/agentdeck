import {
  InteractionSpecSchema,
  type InteractionAnswer,
  type InteractionField,
  type InteractionSpec,
} from '@agentdeck/shared/conversation';
import { elicitationField, record, text, list } from './user-interaction-fields';
type PreparedInteraction = { spec: InteractionSpec; answer(value: InteractionAnswer): Record<string, unknown> };
function questions(value: unknown, claude: boolean): PreparedInteraction {
  const input = record(value);
  const entries = list(input.questions).map(record);
  if (!entries.length || entries.length > 4) throw new Error('原生问题数量不受支持');
  const ids = entries.map((entry) => text(claude ? entry.question : entry.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('原生问题身份无效');
  const fields = entries.map((question, index): InteractionField => {
    const choices = list(question.options).map(record);
    const common = {
      id: `q${index}`,
      label: text(question.question),
      required: true,
      secret: question.isSecret === true,
    };
    if (!choices.length) return { ...common, type: 'text', maxLength: 4096 };
    return {
      ...common,
      type: 'choice',
      multiple: claude && question.multiSelect === true,
      allowOther: claude || question.isOther === true,
      options: choices.map((choice) => ({
        value: text(choice.label),
        label: text(choice.label),
        description: text(choice.description) || undefined,
      })),
    };
  });
  const spec = InteractionSpecSchema.parse({
    kind: 'questions',
    title: '需要你的回答',
    blocking: claude || input.isBlocking !== false,
    fields,
  });
  return {
    spec,
    answer(answer) {
      if (answer.action !== 'submit') return { answers: {} };
      return {
        answers: Object.fromEntries(
          entries.map((question, index) => {
            const raw = answer.values[`q${index}`];
            const values = Array.isArray(raw) ? raw : [String(raw ?? '')];
            return [
              claude ? text(question.question) : text(question.id),
              claude ? values.join(', ') : { answers: values },
            ];
          }),
        ),
      };
    },
  };
}
export const claudeQuestion = (value: unknown): PreparedInteraction => questions(value, true);
export const codexQuestion = (value: unknown): PreparedInteraction => questions(value, false);

export function nativeElicitation(value: unknown): PreparedInteraction {
  const input = record(value);
  if (input.mode === 'url')
    return {
      spec: InteractionSpecSchema.parse({
        kind: 'url',
        title: text(input.message) || '需要授权',
        blocking: true,
        url: input.url,
      }),
      answer: (answer) => ({ action: answer.action === 'submit' ? 'accept' : answer.action }),
    };
  if (input.mode !== 'form') throw new Error('当前原生表单类型不受支持');
  const schema = record(input.requestedSchema);
  validateForm(schema);
  const required = new Set(list(schema.required).map(text));
  const entries = Object.entries(record(schema.properties));
  const fields = entries.map(([name, field], index) =>
    elicitationField(record(field), { id: `f${index}`, label: name, required: required.has(name) }),
  );
  const spec = InteractionSpecSchema.parse({
    kind: 'form',
    title: text(input.message) || text(schema.title) || '需要补充信息',
    blocking: true,
    fields,
  });
  return {
    spec,
    answer(answer) {
      if (answer.action !== 'submit') return { action: answer.action };
      const content = Object.fromEntries(
        entries.flatMap(([name], index) =>
          Object.hasOwn(answer.values, `f${index}`) ? [[name, answer.values[`f${index}`]]] : [],
        ),
      );
      return { action: 'accept', content };
    },
  };
}
function validateForm(schema: Record<string, unknown>) {
  const allowed = new Set([
    'type',
    'properties',
    'required',
    'title',
    'description',
    '$schema',
    'additionalProperties',
  ]);
  if (schema.type !== 'object' || Object.keys(schema).some((key) => !allowed.has(key)))
    throw new Error('当前原生表单约束不受支持');
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((value) => typeof value !== 'string'))
  )
    throw new Error('原生表单必填约束无效');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
    throw new Error('原生表单附加字段约束不受支持');
  const required = new Set(list(schema.required).map(text));
  if (required.size && [...required].some((key) => !Object.hasOwn(record(schema.properties), key)))
    throw new Error('原生表单必填字段缺失');
}
