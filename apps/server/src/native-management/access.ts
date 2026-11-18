import type { AgentKind } from '@agentdeck/shared/conversation';
export type NativeManagementProject = { id: string; dir: string };
export type NativeManagementAccess = {
  read<T>(agent: AgentKind, operation: () => Promise<T>): Promise<T>;
  write<T>(agent: AgentKind, project: NativeManagementProject | undefined, operation: () => Promise<T>): Promise<T>;
};

type Deps = {
  withIdleAgent<T>(agent: AgentKind, operation: () => Promise<T>): Promise<T>;
  native: {
    run<T>(agent: AgentKind, operation: () => Promise<T>): Promise<T>;
    exclusive<T>(agent: AgentKind, operation: () => Promise<T>): Promise<T>;
  };
  workspace: { withIdle<T>(id: string, operation: () => Promise<T>): Promise<T> };
};
/** 固定顺序：CLI 运行 → 原生进程 → 项目 → 文件事务；内部操作不得再次取得同一租约。 */
export function createNativeManagementAccess(deps: Deps): NativeManagementAccess {
  return {
    read: (agent, operation) => deps.native.run(agent, operation),
    write: (agent, project, operation) =>
      deps.withIdleAgent(agent, () =>
        deps.native.exclusive(agent, () => (project ? deps.workspace.withIdle(project.id, operation) : operation())),
      ),
  };
}
