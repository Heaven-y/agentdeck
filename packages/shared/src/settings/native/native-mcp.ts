import { z } from 'zod';
import type { AgentKind } from '../../conversation/agents';
import type { NativeResourceScope } from './native-resources';

const Id = z.string().regex(/^[a-f0-9]{64}$/);
const Secret = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z.object({ action: z.literal('replace'), value: z.string().max(16384) }).strict(),
]);
const Secrets = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/), Secret)
  .refine((v) => Object.keys(v).length <= 64);
export const NativeMcpConfigSchema = z
  .object({
    transport: z.enum(['stdio', 'http', 'sse']),
    command: z.string().min(1).max(4096).optional(),
    args: z.array(z.string().max(4096)).max(128).optional(),
    url: Secret.optional(),
    env: Secrets.optional(),
    headers: Secrets.optional(),
    bearerTokenEnvVar: z.union([z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.null()]).optional(),
  })
  .strict();
export const NativeMcpSaveSchema = z
  .object({
    id: Id.optional(),
    sourceId: Id,
    revision: Id,
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    config: NativeMcpConfigSchema,
  })
  .strict();
export const NativeMcpOperateSchema = z
  .object({ id: Id, revision: Id, action: z.enum(['delete', 'enable', 'disable']) })
  .strict();
export type NativeMcpConfigInput = z.infer<typeof NativeMcpConfigSchema>;
export type NativeMcpSaveInput = z.infer<typeof NativeMcpSaveSchema>;
export type NativeMcpOperateInput = z.infer<typeof NativeMcpOperateSchema>;
export type NativeMcpRuntimeState =
  | 'unchecked'
  | 'notStarted'
  | 'starting'
  | 'connected'
  | 'authenticationRequired'
  | 'failed'
  | 'cancelled'
  | 'disabled'
  | 'unknown';
export type NativeMcpEntry = {
  id: string;
  sourceId: string;
  revision: string;
  name: string;
  scope: NativeResourceScope;
  source: string;
  owner?: string;
  managedBy?: 'session-tools';
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
  enabled: boolean | null;
  runtime: NativeMcpRuntimeState;
  config: {
    command?: string;
    argsConfigured: boolean;
    urlConfigured: boolean;
    urlOrigin?: string;
    envKeys: string[];
    headerKeys: string[];
    bearerTokenEnvVar?: string;
  };
  actions: { edit: boolean; delete: boolean; enable: boolean; disable: boolean };
  reason?: string;
};
export type NativeMcpSource = {
  id: string;
  revision: string;
  scope: NativeResourceScope;
  label: string;
  writable: boolean;
  transports: Array<'stdio' | 'http' | 'sse'>;
  secretInput: boolean;
};
export type NativeMcpCatalog = {
  agent: AgentKind;
  entries: NativeMcpEntry[];
  sources: NativeMcpSource[];
  warnings: string[];
};
export type NativeMcpStatus = {
  instanceId: string;
  name: string;
  state: NativeMcpRuntimeState;
  auth: string;
  tools: string[];
  nextCursor?: string;
  canReconnect: boolean;
  canToggle: boolean;
  canLogin: boolean;
};
export type NativeMcpOperation = {
  id: string;
  instanceId: string;
  name: string;
  state: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'expired';
  authorizationUrl?: string;
};
