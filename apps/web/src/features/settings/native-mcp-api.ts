import type {
  NativeManagementContext,
  NativeMcpCatalog,
  NativeMcpSaveInput,
  NativeMcpOperateInput,
  NativeMcpOperation,
  NativeMcpStatus,
} from '@agentdeck/shared/settings';
import { request } from '../../lib/http';
export type McpCatalog = NativeMcpCatalog & {
  instanceId?: string;
  instances: Array<{ instanceId: string; sessionId?: string; cwd?: string }>;
  operations?: NativeMcpOperation[];
};
const url = (context: NativeManagementContext, suffix = '', instanceId?: string) => {
  const query = new URLSearchParams();
  if (context.projectId) query.set('projectId', context.projectId);
  if (instanceId) query.set('instanceId', instanceId);
  return `/api/native-management/${context.agent}/mcp${suffix}${query.size ? `?${query}` : ''}`;
};
const post = <T>(context: NativeManagementContext, suffix: string, input: unknown) =>
  request<T>(url(context, suffix), { method: 'POST', body: JSON.stringify(input), cache: 'no-store' });
export const nativeMcpApi = {
  read: (context: NativeManagementContext, signal?: AbortSignal, instanceId?: string) =>
    request<McpCatalog>(url(context, '', instanceId), { signal, cache: 'no-store' }),
  save: (context: NativeManagementContext, input: NativeMcpSaveInput) => post(context, '/save', input),
  change: (context: NativeManagementContext, input: NativeMcpOperateInput) => post(context, '/change', input),
  control: (
    context: NativeManagementContext,
    input: { id: string; revision: string; action: string; instanceId?: string; cursor?: string },
  ) => post<NativeMcpStatus | NativeMcpOperation>(context, '/control', input),
  oauth: (context: NativeManagementContext, id: string, action: 'read' | 'cancel') =>
    post<NativeMcpOperation>(context, '/oauth', { id, action }),
};
