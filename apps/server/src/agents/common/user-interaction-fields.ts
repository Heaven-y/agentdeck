import type { InteractionField } from '@agentdeck/shared/conversation';
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
function number(value: unknown): number | undefined {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('原生数值约束无效');
  return value;
}
function range(field: Record<string, unknown>, min: string, max: string) {
  const lower = number(field[min]);
  const upper = number(field[max]);
  if (lower !== undefined && upper !== undefined && lower > upper) throw new Error('原生字段范围无效');
  return [lower, upper] as const;
}
const COMMON = ['type', 'title', 'description', 'default'];
function assertKeys(field: Record<string, unknown>, extra: string[]) {
  if (Object.keys(field).some((key) => ![...COMMON, ...extra].includes(key)))
    throw new Error('当前原生表单字段约束不受支持');
}
function enumOptions(field: Record<string, unknown>) {
  assertEnum(field);
  if (Array.isArray(field.oneOf)) return field.oneOf.map(enumOption);
  if (!Array.isArray(field.enum) || field.enum.some((value) => typeof value !== 'string'))
    throw new Error('原生枚举格式不受支持');
  return field.enum.map((value, index) => ({
    value: value as string,
    label: text(list(field.enumNames)[index]) || (value as string),
  }));
}
function assertEnum(field: Record<string, unknown>) {
  if (field.type !== undefined && field.type !== 'string') throw new Error('原生枚举类型不受支持');
  if (field.enum !== undefined && field.oneOf !== undefined) throw new Error('原生组合枚举不受支持');
  if (
    field.enumNames !== undefined &&
    (!Array.isArray(field.enumNames) || field.enumNames.some((value) => typeof value !== 'string'))
  )
    throw new Error('原生枚举标题无效');
}
function enumOption(value: unknown) {
  const entry = record(value);
  if (typeof entry.const !== 'string' || Object.keys(entry).some((key) => !['const', 'title'].includes(key)))
    throw new Error('原生枚举约束不受支持');
  return { value: entry.const, label: text(entry.title) || entry.const };
}
type FieldBase = { id: string; label: string; required: boolean };
function choice(field: Record<string, unknown>, base: FieldBase, multiple: boolean): InteractionField {
  assertKeys(field, multiple ? ['items', 'minItems', 'maxItems', 'uniqueItems'] : ['enum', 'enumNames', 'oneOf']);
  const source = multiple ? record(field.items) : field;
  if (multiple) assertKeys(source, ['enum', 'enumNames', 'oneOf']);
  if (field.uniqueItems !== undefined && field.uniqueItems !== true) throw new Error('当前表单只支持不重复选择');
  const [minSelections, maxSelections] = range(field, 'minItems', 'maxItems');
  const options = enumOptions(source);
  if (new Set(options.map((option) => option.value)).size !== options.length) throw new Error('原生枚举选项重复');
  return { ...base, type: 'choice', multiple, options, ...(multiple ? { minSelections, maxSelections } : {}) };
}
export function elicitationField(field: Record<string, unknown>, base: FieldBase): InteractionField {
  const common = fieldLabel(field, base);
  if (field.type === 'array') return choice(field, common, true);
  if (field.type === 'string' && (Array.isArray(field.enum) || Array.isArray(field.oneOf)))
    return choice(field, common, false);
  if (field.type === 'boolean') {
    assertKeys(field, []);
    return { ...common, type: 'boolean' };
  }
  if (field.type === 'number' || field.type === 'integer') {
    assertKeys(field, ['minimum', 'maximum']);
    const [minimum, maximum] = range(field, 'minimum', 'maximum');
    return { ...common, type: 'number', integer: field.type === 'integer', minimum, maximum };
  }
  if (field.type === 'string') return textField(field, common);
  throw new Error('当前原生表单字段类型不受支持');
}
function fieldLabel(field: Record<string, unknown>, base: FieldBase) {
  return { ...base, label: text(field.title) || base.label, description: text(field.description) || undefined };
}
function textField(field: Record<string, unknown>, common: FieldBase): InteractionField {
  assertKeys(field, ['minLength', 'maxLength', 'format']);
  if (field.format !== undefined && typeof field.format !== 'string') throw new Error('原生文字格式无效');
  const format = text(field.format);
  if (format && !['email', 'uri', 'date', 'date-time', 'password'].includes(format))
    throw new Error('原生文字格式不受支持');
  const [minLength, maxLength] = range(field, 'minLength', 'maxLength');
  return {
    ...common,
    type: 'text',
    secret: format === 'password',
    minLength,
    maxLength,
    ...(format && format !== 'password' ? { format: format as 'email' | 'uri' | 'date' | 'date-time' } : {}),
  };
}
