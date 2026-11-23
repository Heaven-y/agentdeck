import type { NativeManagementContext } from '@agentdeck/shared/settings';

const workspaceScopes = new Set(['project', 'local', 'directory']);

/** 目录可能包含继承条目；只列属于当前页的来源和可写位置。 */
export function inNativeScope(context: NativeManagementContext, scope: string): boolean {
  return Boolean(context.projectId) === workspaceScopes.has(scope);
}
