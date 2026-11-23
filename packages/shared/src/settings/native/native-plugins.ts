import { z } from 'zod';
import type { AgentKind } from '../../conversation/agents';
export const NativePluginActionSchema = z.enum([
  'install',
  'uninstall',
  'enable',
  'disable',
  'update',
  'validate',
  'configure',
  'marketplace-add',
  'marketplace-remove',
  'marketplace-refresh',
]);
export type NativePluginAction = z.infer<typeof NativePluginActionSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const NativePluginPrepareSchema = z
  .object({
    action: NativePluginActionSchema,
    revision: digest,
    configurationRevision: digest.optional(),
    id: digest.optional(),
    source: z.string().min(1).max(2048).optional(),
    scope: z.enum(['user', 'project', 'local']).optional(),
    values: z
      .record(
        z.string().min(1).max(128),
        z
          .string()
          .max(8192)
          .refine((value) => !/[\r\n\0]/.test(value)),
      )
      .optional(),
  })
  .strict();
export const NativePluginStartSchema = z
  .object({ operationId: z.string().uuid(), revision: digest, confirmation: digest.optional() })
  .strict();
export type NativePluginPrepareInput = z.infer<typeof NativePluginPrepareSchema>;
export type NativePluginStartInput = z.infer<typeof NativePluginStartSchema>;
export type NativePluginEntry = {
  id: string;
  revision: string;
  selector: string;
  name: string;
  source: string;
  marketplace?: string;
  scope: string;
  version: string | null;
  enabled: boolean | null;
  description: string;
  actions: NativePluginAction[];
  components: string[];
  reason?: string;
};
export type NativePluginMarketplace = {
  id: string;
  revision: string;
  name: string;
  source: string;
  scope: string;
  actions: NativePluginAction[];
};
export type NativePluginOption = {
  key: string;
  title: string;
  description: string;
  sensitive: boolean;
  required: boolean;
  configured: boolean;
  choices?: string[];
};
export type NativePluginOperation = {
  operationId: string;
  revision: string;
  agent: AgentKind;
  projectId?: string;
  action: NativePluginAction;
  target: string;
  source: string;
  scope: string;
  impact: string;
  status:
    'prepared' | 'running' | 'awaiting-confirmation' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'unknown';
  createdAt: string;
  updatedAt: string;
  message?: string;
  shownCommand?: { command: string; sha256: string };
};
export type NativePluginCatalog = {
  agent: AgentKind;
  revision: string;
  entries: NativePluginEntry[];
  marketplaces: NativePluginMarketplace[];
  operations: NativePluginOperation[];
  installScopes: Array<'user' | 'project' | 'local'>;
  canInstall: boolean;
  canAddMarketplace: boolean;
  warnings: string[];
};
