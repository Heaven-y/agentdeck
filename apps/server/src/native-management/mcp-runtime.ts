import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativeMcpStatus } from '@agentdeck/shared/settings';
import { NativeManagementError } from './errors';
import { resourcePathKey } from '../agents/common/configuration/resources';
import type { NativeManagementProject } from './types';
export type McpControl = {
  status(name: string, cursor?: string): Promise<NativeMcpStatus>;
  reconnect?(name: string): Promise<void>;
  toggle?(name: string, enabled: boolean): Promise<void>;
};
export type McpRuntime = {
  agent: AgentKind;
  projectId: string;
  cwd: string;
  instanceId: string;
  sessionId(): string | undefined;
  control: McpControl;
};
/** 实例拥有者保存引用；控制租约既不等待回合空闲，也不创建新的对话。 */
export class McpRuntimeRegistry {
  private readonly runtimes = new Map<string, McpRuntime & { lifetime: AbortController; busy: boolean }>();
  register(runtime: McpRuntime): () => void {
    const current = { ...runtime, cwd: resourcePathKey(runtime.cwd), lifetime: new AbortController(), busy: false };
    this.runtimes.set(runtime.instanceId, current);
    return () => {
      current.lifetime.abort();
      if (this.runtimes.get(runtime.instanceId) === current) this.runtimes.delete(runtime.instanceId);
    };
  }
  list(agent: AgentKind, project: NativeManagementProject) {
    return [...this.runtimes.values()]
      .filter((r) => r.agent === agent && r.projectId === project.id && r.cwd === resourcePathKey(project.dir))
      .map((r) => ({ instanceId: r.instanceId, sessionId: r.sessionId() }));
  }
  async use<T>(
    agent: AgentKind,
    project: NativeManagementProject,
    instanceId: string,
    operation: (runtime: McpRuntime, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const runtime = this.runtimes.get(instanceId);
    if (
      !runtime ||
      runtime.agent !== agent ||
      runtime.projectId !== project.id ||
      runtime.cwd !== resourcePathKey(project.dir) ||
      runtime.lifetime.signal.aborted ||
      runtime.busy
    )
      throw new NativeManagementError('native_unavailable');
    runtime.busy = true;
    try {
      const result = await operation(runtime, runtime.lifetime.signal);
      if (runtime.lifetime.signal.aborted) throw new NativeManagementError('native_unavailable');
      return result;
    } catch {
      throw new NativeManagementError('native_unavailable');
    } finally {
      runtime.busy = false;
    }
  }
}
