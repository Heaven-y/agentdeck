import type { NativePluginAction, NativePluginEntry, NativePluginMarketplace } from '@agentdeck/shared/settings';
import type { ResourceContext } from '../../agents/common/configuration/resources';
import type { ProcessOptions, ProcessResult } from '../../platform/process/run';
import type { NativeConfigSource } from '../config';
import type { PluginPolicy } from './plugin-policy';
export type PluginContext = ResourceContext & {
  run(args: string[], options?: Partial<ProcessOptions>): Promise<ProcessResult>;
  readPolicy?(): Promise<PluginPolicy>;
};
export type PluginRecord = {
  selector: string;
  name: string;
  scope: string;
  root?: string;
  source: string;
  marketplace?: string;
  version: string | null;
  enabled: boolean | null;
  description?: string;
  components?: string[];
  actions: NativePluginAction[];
  raw: unknown;
  config?: NativeConfigSource;
  reason?: string;
  entry?: NativePluginEntry;
};
export type PluginMarketplace = {
  name: string;
  scope: string;
  source: string;
  root?: string;
  raw: unknown;
  actions: NativePluginAction[];
  entry?: NativePluginMarketplace;
};
export type PluginInventory = {
  plugins: PluginRecord[];
  marketplaces: PluginMarketplace[];
  revisions: unknown[];
  warnings: string[];
};
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const string = (value: unknown) => (typeof value === 'string' ? value : '');
