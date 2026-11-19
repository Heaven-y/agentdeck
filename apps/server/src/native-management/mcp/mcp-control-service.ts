import type { AgentKind } from '@agentdeck/shared/conversation';
import type { NativeMcpService } from './mcp-service';
import type { NativeManagementAccess, NativeManagementProject } from '../access';
import type { McpRuntimeRegistry } from './mcp-runtime';
import { McpOAuthOperations } from './mcp-oauth';
import { loginCodexMcp } from '../../agents/codex/interaction/mcp-oauth';
import { checkMcpConnection } from './mcp-check';
import { NativeManagementError } from '../errors';
import { resourcePathKey } from '../../agents/common/configuration/resources';
type Input = {
  id: string;
  revision: string;
  instanceId?: string;
  cursor?: string;
  action: 'check' | 'reconnect' | 'runtime-enable' | 'runtime-disable' | 'login';
};
export function createMcpControlService(deps: {
  service: NativeMcpService;
  registry: McpRuntimeRegistry;
  access: NativeManagementAccess;
  workspace: { acquire(id: string): () => void; get(id: string): Promise<NativeManagementProject | undefined> };
}) {
  const oauth = new McpOAuthOperations();
  async function withProject<T>(project: NativeManagementProject | undefined, operation: () => Promise<T>): Promise<T> {
    if (!project) return operation();
    // 普通活动租约允许与等待授权的回合共存，但阻止换目录/删除；先取得再重读，拒绝旧 HTTP 上下文。
    const release = deps.workspace.acquire(project.id);
    try {
      const current = await deps.workspace.get(project.id);
      if (!current || resourcePathKey(current.dir) !== resourcePathKey(project.dir))
        throw new NativeManagementError('native_unavailable');
      return await operation();
    } finally {
      release();
    }
  }
  function login(
    agent: AgentKind,
    input: Input,
    target: Awaited<ReturnType<NativeMcpService['resolveMcp']>>,
    scope: { project?: NativeManagementProject; runtimeProject?: NativeManagementProject; lifetime?: AbortSignal },
  ) {
    const { project, runtimeProject = project, lifetime } = scope;
    if (agent !== 'codex' || target.entry.transport !== 'http' || target.ambiguous)
      throw new NativeManagementError('unsupported_action');
    return oauth.start(
      {
        agent,
        projectId: project?.id,
        name: target.entry.name,
        instanceId: input.instanceId ?? `standalone:${target.entry.id}:${target.entry.revision}`,
      },
      (session) =>
        // start 同步进入此回调，在外层短租约释放前接续覆盖整个后台授权生命期。
        withProject(project, () =>
          deps.access.read(agent, async () => {
            const current = await deps.service.resolveMcp(agent, input.id, input.revision, runtimeProject);
            if (current.ambiguous) throw new NativeManagementError('unsupported_action');
            return loginCodexMcp(current.context, current.entry.name, session);
          }),
        ),
      lifetime,
    );
  }
  return {
    instances: (agent: AgentKind, project?: NativeManagementProject) =>
      project ? deps.registry.list(agent, project) : [],
    async catalog(agent: AgentKind, project?: NativeManagementProject, instanceId?: string) {
      return withProject(project, async () => {
        if (!instanceId) return deps.service.readMcp(agent, project);
        if (!project) throw new NativeManagementError('native_unavailable');
        return deps.registry.use(agent, project, instanceId, async (runtime) => {
          const catalog = await deps.service.readMcp(agent, { ...project, dir: runtime.cwd });
          // 实例目录只提供运行控制；持久配置仍从项目配置入口管理。
          return {
            ...catalog,
            entries: catalog.entries.map((entry) => ({
              ...entry,
              actions: { edit: false, delete: false, enable: false, disable: false },
            })),
            sources: catalog.sources.map((source) => ({ ...source, writable: false })),
            warnings: [...catalog.warnings, '当前展示所选实例目录的配置；修改持久配置请切回项目配置与单次检查。'],
          };
        });
      });
    },
    oauth,
    async operate(agent: AgentKind, input: Input, project?: NativeManagementProject) {
      if (input.instanceId && !project) throw new NativeManagementError('native_unavailable');
      return withProject(project, () => operate(agent, input, project));
    },
  };
  async function operate(agent: AgentKind, input: Input, project?: NativeManagementProject) {
    if (agent === 'antigravity') throw new NativeManagementError('unsupported_action');
    if (input.instanceId && project)
      return deps.registry.use(agent, project, input.instanceId, async ({ control, cwd }, lifetime) => {
        const runtimeProject = { ...project, dir: cwd };
        const target = await deps.service.resolveMcp(agent, input.id, input.revision, runtimeProject);
        // 原生控制仅接受名称；同名来源无法证明对应所选配置时不执行。
        if (target.ambiguous) throw new NativeManagementError('unsupported_action');
        const name = target.entry.name;
        if (input.action === 'login') return login(agent, input, target, { project, runtimeProject, lifetime });
        if (input.action === 'reconnect') {
          if (!control.reconnect) throw new NativeManagementError('unsupported_action');
          await control.reconnect(name);
        }
        if (input.action === 'runtime-enable' || input.action === 'runtime-disable') {
          if (!control.toggle) throw new NativeManagementError('unsupported_action');
          await control.toggle(name, input.action === 'runtime-enable');
        }
        return control.status(name, input.cursor);
      });
    if (input.action === 'login') {
      const target = await deps.service.resolveMcp(agent, input.id, input.revision, project);
      return login(agent, input, target, { project });
    }
    if (input.action !== 'check') throw new NativeManagementError('unsupported_action');
    return deps.access.read(agent, async () => {
      const current = await deps.service.resolveMcp(agent, input.id, input.revision, project);
      if (current.ambiguous || current.entry.transport === 'unknown')
        throw new NativeManagementError('unsupported_action');
      return checkMcpConnection(current.context, current.entry.name, current.config);
    });
  }
}
export type McpControlService = ReturnType<typeof createMcpControlService>;
