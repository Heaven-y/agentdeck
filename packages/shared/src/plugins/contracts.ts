import { z } from 'zod';
import { AgentKindSchema, NativeSessionIdSchema, type AgentKind } from '../conversation/agents';
import { SessionHistoryPageQuerySchema } from '../conversation/sessions/session';

export const WorkbenchPluginIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const WorkbenchPluginPermissionSchema = z.enum([
  'storage',
  'project-context',
  'backend',
  'clipboard',
  'projects',
  'session-history',
  'session-context',
  'composer',
]);
export const WorkbenchPluginCommandSchema = z
  .object({
    id: WorkbenchPluginIdSchema,
    title: z.string().trim().min(1).max(80),
    execution: z.enum(['page', 'background']).optional(),
    page: WorkbenchPluginIdSchema.optional(),
  })
  .strict();
const Manifest = z
  .object({
    id: WorkbenchPluginIdSchema,
    name: z.string().trim().min(1).max(80),
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
    entry: z.string().min(1).max(240).endsWith('.html'),
    description: z.string().max(1000).optional(),
    icon: z.enum(['terminal', 'puzzle']).optional(),
    permissions: z.array(WorkbenchPluginPermissionSchema).max(8).default([]),
    /** 命令交付给插件自己的文档，不直接执行系统命令。 */
    commands: z.array(WorkbenchPluginCommandSchema).max(32).default([]),
  })
  .strict();
export const WorkbenchPluginEventNameSchema = z.enum(['context.changed', 'turn.started', 'turn.completed']);
const Contributions = z
  .strictObject({
    pages: z
      .array(
        z.strictObject({
          id: WorkbenchPluginIdSchema,
          title: z.string().trim().min(1).max(80),
          location: z.enum(['sidebar', 'settings']),
        }),
      )
      .max(16)
      .default([]),
    actions: z
      .array(z.strictObject({ command: WorkbenchPluginIdSchema, location: z.enum(['composer', 'session']) }))
      .max(32)
      .default([]),
  })
  .refine((value) => new Set(value.pages.map((page) => page.id)).size === value.pages.length)
  .refine(
    (value) =>
      new Set(value.actions.map((action) => `${action.location}:${action.command}`)).size === value.actions.length,
  );
export const WorkbenchPluginManifestSchema = z
  .discriminatedUnion('apiVersion', [
    Manifest.extend({ apiVersion: z.literal(1) }).refine(
      (value) =>
        value.permissions.every((permission) => permission === 'storage' || permission === 'project-context') &&
        value.commands.every((command) => !command.execution && !command.page),
    ),
    Manifest.extend({
      apiVersion: z.literal(2),
      backend: z.string().min(1).max(240).endsWith('.cjs').optional(),
      contributes: Contributions.optional(),
      events: z.array(WorkbenchPluginEventNameSchema).max(3).optional(),
    })
      .refine((value) => !!value.backend === value.permissions.includes('backend'))
      .refine(
        (value) =>
          value.contributes?.actions.every((action) =>
            value.commands.some((command) => command.id === action.command),
          ) ?? true,
      )
      .refine((value) =>
        value.commands.every((command) => !command.page || pluginPages(value).some((page) => page.id === command.page)),
      )
      .refine((value) =>
        value.commands.every((command) =>
          command.execution === 'background' ? !command.page : pluginPages(value).length > 0,
        ),
      )
      .refine((value) => !value.events || new Set(value.events).size === value.events.length)
      .refine((value) => !value.events?.length || value.permissions.includes('session-context')),
  ])
  .refine((manifest) => new Set(manifest.permissions).size === manifest.permissions.length)
  .refine((manifest) => new Set(manifest.commands.map((command) => command.id)).size === manifest.commands.length);

export type WorkbenchPluginManifest = z.infer<typeof WorkbenchPluginManifestSchema>;
export type WorkbenchPluginPermission = z.infer<typeof WorkbenchPluginPermissionSchema>;
export type WorkbenchPluginCommand = z.infer<typeof WorkbenchPluginCommandSchema>;
export type WorkbenchPluginPageContribution = z.infer<typeof Contributions>['pages'][number];
export type WorkbenchPluginEventName = z.infer<typeof WorkbenchPluginEventNameSchema>;
/** 未声明贡献的旧插件继续提供一个侧栏主页面。显式空列表可声明纯后台扩展。 */
export function pluginPages(manifest: {
  name: string;
  contributes?: z.infer<typeof Contributions>;
}): WorkbenchPluginPageContribution[] {
  return manifest.contributes?.pages ?? [{ id: 'main', title: manifest.name, location: 'sidebar' }];
}
export function pluginActions(manifest: WorkbenchPluginManifest) {
  return manifest.apiVersion === 2 ? (manifest.contributes?.actions ?? []) : [];
}
export const WorkbenchPluginHostRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('projects.list') }),
  z.strictObject({
    method: z.literal('sessions.list'),
    params: z.strictObject({
      projectId: z.string().min(1).max(200),
      agent: AgentKindSchema,
      cursor: z.string().min(1).max(8192).optional(),
    }),
  }),
  z.strictObject({
    method: z.literal('sessions.history'),
    params: z.strictObject({
      projectId: z.string().min(1).max(200),
      agent: AgentKindSchema,
      sessionId: NativeSessionIdSchema,
      before: SessionHistoryPageQuerySchema.shape.before,
    }),
  }),
]);
export type WorkbenchPluginHostRequest = z.infer<typeof WorkbenchPluginHostRequestSchema>;
export type WorkbenchPluginSessionContext = {
  conversationId: string;
  workspaceId?: string;
  agent: AgentKind;
  sessionId?: string;
  running: boolean;
};
export type WorkbenchPluginEvent = { name: WorkbenchPluginEventName; session: WorkbenchPluginSessionContext };
export type WorkbenchPlugin = {
  manifest: WorkbenchPluginManifest;
  enabled: boolean;
  installedAt?: number;
};
export type WorkbenchPluginCatalog = { plugins: WorkbenchPlugin[]; revision: string };
export type WorkbenchPluginInstallInput = { directory: string; revision?: string };
export type WorkbenchPluginUpdateInput = { enabled: boolean; revision: string };
export type WorkbenchPluginRemoveInput = { revision: string };
export type WorkbenchPluginPage = { html: string };
export type WorkbenchPluginStorage = { value: Record<string, z.infer<ReturnType<typeof z.json>>>; revision: string };
export type WorkbenchPluginStorageInput = WorkbenchPluginStorage;
export const WorkbenchPluginBackendRequestSchema = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^\/(?!\/)[^\r\n\\#]*$/),
  body: z.json().optional(),
});
export type WorkbenchPluginBackendRequest = z.infer<typeof WorkbenchPluginBackendRequestSchema>;
export type WorkbenchPluginBackendResponse = { status: number; body: unknown };
