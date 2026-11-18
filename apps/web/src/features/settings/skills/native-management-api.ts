import type {
  NativeManagementContext,
  NativeManagementResult,
  NativeSkillChangeInput,
  NativeSkillImportInput,
  NativeSkillsCatalog,
} from '@agentdeck/shared/settings';
import { request } from '../../../lib/http';
const url = (context: NativeManagementContext, suffix = '') =>
  `/api/native-management/${context.agent}/skills${suffix}${context.projectId ? `?${new URLSearchParams({ projectId: context.projectId })}` : ''}`;
export const nativeManagementApi = {
  skills: (context: NativeManagementContext, signal?: AbortSignal) =>
    request<NativeSkillsCatalog>(url(context), { signal, cache: 'no-store' }),
  changeSkill: (context: NativeManagementContext, input: NativeSkillChangeInput) =>
    request<NativeManagementResult>(url(context, '/change'), {
      method: 'POST',
      body: JSON.stringify(input),
      cache: 'no-store',
    }),
  importSkill: (context: NativeManagementContext, input: NativeSkillImportInput) =>
    request<NativeManagementResult>(url(context, '/import'), {
      method: 'POST',
      body: JSON.stringify(input),
      cache: 'no-store',
    }),
};
