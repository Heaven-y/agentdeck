import type { ResourceContext } from '../agents/common/configuration/resources';
import type { SkillConfigSource } from './types';
import type { NativeResourceScope } from '@agentdeck/shared/settings';
export type McpSource = SkillConfigSource & {
  key: string[];
  label: string;
  commandScope?: 'user' | 'local';
  readOnly?: boolean;
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
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export function serverMap(source: McpSource): Record<string, unknown> {
  let value: unknown = source.data;
  for (const part of source.key) value = object(value)[part];
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new Error('MCP 配置结构无效');
  return object(value);
}
