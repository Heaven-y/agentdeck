import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser';
import { updateTomlFields } from '../platform/files/toml-fields';

type Field = { path: string[]; node: AST.TOMLKeyValue };
const prefix = (parent: string[], child: string[]) =>
  parent.length <= child.length && parent.every((p, i) => p === child[i]);
function fields(program: AST.TOMLProgram): Field[] {
  const result: Field[] = [];
  const add = (node: AST.TOMLKeyValue, parent: string[]) => {
    const path = [...parent, ...getStaticTOMLValue(node.key)];
    result.push({ path, node });
    if (node.value.type === 'TOMLInlineTable') for (const entry of node.value.body) add(entry, path);
  };
  for (const node of program.body[0].body) {
    if (node.type === 'TOMLKeyValue') add(node, []);
    else for (const entry of node.body) add(entry, node.resolvedKey.map(String));
  }
  return result;
}
function removal(program: AST.TOMLProgram, node: AST.TOMLKeyValue): AST.Range[] {
  if (node.parent.type !== 'TOMLInlineTable' || node.parent.body.length === 1) return [node.range];
  const siblings = node.parent.body,
    position = siblings.indexOf(node),
    next = siblings[position + 1];
  const start = next ? node.range[1] : siblings[position - 1]!.range[1],
    end = next ? next.range[0] : node.range[0];
  const comma = program.tokens.find((t) => t.value === ',' && t.range[0] >= start && t.range[1] <= end);
  if (!comma) throw new Error('TOML 无法安全修改');
  return [node.range, comma.range];
}
function encode(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(', ')}]`;
  if (value && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)} = ${encode(v)}`)
      .join(', ')} }`;
  throw new Error('TOML 值无效');
}
/** 定点修改已选 MCP 字段；未知字段、旁支表和所有独立注释保留。 */
function deleteKey(raw: string, program: AST.TOMLProgram, key: string[], exact?: Field) {
  const ranges = exact
    ? removal(program, exact.node)
    : fields(program)
        .filter((f) => f.node.parent.type !== 'TOMLInlineTable' && prefix(key, f.path))
        .map((f) => f.node.range);
  if (!exact)
    for (const node of program.body[0].body)
      if (node.type === 'TOMLTable' && prefix(key, node.resolvedKey.map(String)))
        ranges.push([node.range[0], raw.indexOf(']', node.key.range[1]) + 1]);
  return ranges.sort((a, b) => b[0] - a[0]).reduce((text, r) => text.slice(0, r[0]) + text.slice(r[1]), raw);
}
export function editMcpToml(content: string, key: string[], value: unknown): string {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  let raw = content.slice(bom.length),
    program = parseTOML(raw, { tomlVersion: '1.0' });
  const entries = fields(program),
    exact = entries.find((f) => f.path.length === key.length && prefix(key, f.path));
  if (value === undefined) {
    raw = deleteKey(raw, program, key, exact);
  } else if (exact) {
    raw = raw.slice(0, exact.node.value.range[0]) + encode(value) + raw.slice(exact.node.value.range[1]);
  } else {
    raw = updateTomlFields(raw, [{ path: key, value: 'agentdeck-mcp-placeholder' }]);
    program = parseTOML(raw, { tomlVersion: '1.0' });
    const inserted = fields(program).find((f) => f.path.length === key.length && prefix(key, f.path))!;
    raw = raw.slice(0, inserted.node.value.range[0]) + encode(value) + raw.slice(inserted.node.value.range[1]);
  }
  parseTOML(raw, { tomlVersion: '1.0' });
  return bom + raw;
}
export function patchMcpToml(
  content: string,
  key: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  let result = content;
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[field],
      value = after[field];
    if (JSON.stringify(old) === JSON.stringify(value)) continue;
    if (
      old &&
      value &&
      typeof old === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(old) &&
      !Array.isArray(value)
    )
      result = patchMcpToml(result, [...key, field], old as Record<string, unknown>, value as Record<string, unknown>);
    else result = editMcpToml(result, [...key, field], value);
  }
  return result;
}
