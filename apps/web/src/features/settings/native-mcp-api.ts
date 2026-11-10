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
  instances: Array<{ instanceId: string; sessionId?: string }>;
  operations?: NativeMcpOperation[];
};
const url = (context: NativeManagementContext, suffix = '') =>
  `/api/native-management/${context.agent}/mcp${suffix}${context.projectId ? `?${new URLSearchParams({ projectId: context.projectId })}` : ''}`;
const post = <T>(context: NativeManagementContext, suffix: string, input: unknown) =>
  request<T>(url(context, suffix), { method: 'POST', body: JSON.stringify(input), cache: 'no-store' });
export const nativeMcpApi = {
  read: (context: NativeManagementContext, signal?: AbortSignal) =>
    request<McpCatalog>(url(context), { signal, cache: 'no-store' }),
  save: (context: NativeManagementContext, input: NativeMcpSaveInput) => post(context, '/save', input),
  change: (context: NativeManagementContext, input: NativeMcpOperateInput) => post(context, '/change', input),
  control: (
    context: NativeManagementContext,
    input: { id: string; revision: string; action: string; instanceId?: string; cursor?: string },
  ) => post<NativeMcpStatus | NativeMcpOperation>(context, '/control', input),
  oauth: (context: NativeManagementContext, id: string, action: 'read' | 'cancel') =>
    post<NativeMcpOperation>(context, '/oauth', { id, action }),
};
