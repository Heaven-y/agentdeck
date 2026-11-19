import type { ResourceContext } from '../../agents/common/configuration/resources';
import type { NativeConfigSource } from '../config';
import { NativeResourceError } from '../../agents/common/configuration/errors';
import type { NativeMcpConfigInput, NativeResourceScope } from '@agentdeck/shared/settings';
export type McpSource = NativeConfigSource & {
  key: string[];
  label: string;
  commandScope?: 'user' | 'local';
  readOnly?: boolean;
};
/** 列表和写入共同使用的原生配置约定。null 表示该 CLI 没有对应能力。 */
export type McpAdapter = {
  sources(context: McpContext): Promise<McpSource[]>;
  format: 'json' | 'toml';
  transports: readonly NativeMcpConfigInput['transport'][];
  /** explicit 会写入标签，hint 只识别已存在的标签；缺省则仅从字段推断。 */
  transportTag?: 'explicit' | 'hint';
  acceptsTransport?(config: Record<string, unknown>, transport: NativeMcpConfigInput['transport']): boolean;
  urlFields: readonly [string, ...string[]];
  headerField: string;
  bearerField: string | null;
  enabledField: 'enabled' | 'disabled' | null;
  warning?: string;
};
export type McpPlugin = {
  name: string;
  owner: string;
  installationRoot: string;
  nativeScope?: string;
  scope?: NativeResourceScope;
  config: Record<string, unknown>;
};
export type McpContext = ResourceContext;
export function isConfigObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export const object = (value: unknown): Record<string, unknown> => (isConfigObject(value) ? value : {});
export function serverMap(source: McpSource): Record<string, unknown> {
  let value = source.data;
  for (const part of source.key) {
    if (!Object.hasOwn(value, part)) return {};
    const nested = value[part];
    if (!isConfigObject(nested))
      throw new NativeResourceError(source.file.endsWith('.toml') ? 'invalid_toml' : 'invalid_json');
    value = nested;
  }
  return value;
}
