// 可编程启动：读取配置、组装依赖、只在本机地址上启动，并返回关闭函数。
// CLI（main.ts）与 Electron 桌面壳共用这里，业务路由与清理路径保持原样。
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { AttachmentStore } from '../chat/attachments/attachments';
import type { ResumeHub } from '../chat/resume-hub';
import { registerChatAttachmentRoutes } from '../http/conversation/chat-attachments.routes';
import { inputCapabilities } from '../chat/capabilities/input-capabilities';
import type { AttachmentCapabilityInput } from '../agents/contracts';
import type { AgentKind } from '@agentdeck/shared/conversation';
import { isAntigravityProxyVariable } from '@agentdeck/shared/settings';
import { createCliActivity, guardSessionProvider } from './cli-activity';
import { createAgentProbes } from '../agents/common/probe';
import { createCliInstallationBackend } from '../cli-installation';
import type { CliInstallationBackend } from '../cli-installation/types';
import { createCliInstallationService } from '../cli-installation/service';
import { registerCliInstallationRoutes } from '../http/settings/cli-installation.routes';
import { runProcess, type ProcessRunner } from '../platform/process/run';
import { createAntigravityRunner } from '../agents/antigravity/adapter';
import { readAntigravityAccount } from '../agents/antigravity/account';
import { invalidateAntigravityModelCatalog } from '../agents/antigravity/models/context-window';
import { discoverAntigravityCapabilities } from '../agents/antigravity/capabilities';
import { readAntigravityConnection } from '../agents/antigravity/models/model-catalog';
import { antigravityLoginEnvironment } from '../agents/antigravity/run/process-environment';
import { readAntigravityOfficialUsage } from '../agents/antigravity/usage/official-usage';
import { readCodexOfficialUsage } from '../agents/codex/account';
import { createAntigravitySessionManagement } from '../agents/antigravity/management/management';
import { createAntigravitySessions } from '../agents/antigravity/history/sessions';
import { createClaudeRunner } from '../agents/claude/adapter';
import { discoverClaudeCapabilities } from '../agents/claude/capabilities';
import { createClaudeSessions } from '../agents/claude/history/sessions';
import {
  assertCodexSession,
  createCodexRunner,
  discoverCodexCapabilities,
  forkCodexSession,
  listCodexSessions,
  pageCodexSessions,
  mutateCodexSession,
  readCodexSession,
  readCodexHistoryPage,
  readCodexMedia,
  readCodexSubagents,
} from '../agents/codex';
import { withCapabilityDirectory } from '../agents/common/capability-directory';
import { createConfiguredRunner } from '../agents/common/configured-runner';
import { createCapabilitiesService } from '../chat/capabilities/capabilities';
import { TurnManager } from '../chat/turn-manager';
import { registerAgentConfigRoutes } from '../http/settings/agent-config.routes';
import { registerCapabilityRoutes } from '../http/conversation/capabilities.routes';
import { readAntigravityMainAgents } from '../agents/antigravity/models/main-agents';
import { registerLaunchEnvironmentRoutes } from '../http/settings/launch-environment.routes';
import { registerModelCatalogRoutes } from '../http/settings/model-catalog.routes';
import {
  registerAntigravityAccountRoute,
  registerAntigravityUsageRoute,
} from '../http/settings/antigravity-usage.routes';
import { registerCodexUsageRoute } from '../http/settings/codex-usage.routes';
import { registerModelSettingsRoutes } from '../http/settings/model-settings.routes';
import { registerNativeResourceRoutes } from '../http/settings/native-resources.routes';
import { registerSessionRoutes } from '../http/conversation/sessions.routes';
import { createSessionPreferences } from '../sessions/preferences';
import { createSessionsService } from '../sessions/service';
import { createLaunchEnvironment } from '../settings/launch-environment';
import { createModelSettingsService } from '../settings/model-settings';
import { createNativeConfigService } from '../settings/native-config';
import { createNativeResourcesService } from '../settings/resources/native-resources';
import { createSessionReferences } from '../sessions/references';
import { createNativeManagementAccess } from '../native-management/access';
import { createNativeManagementService } from '../native-management/skills/service';
import { registerNativeManagementRoutes } from '../http/settings/native-management.routes';
import { createNativeMcpService } from '../native-management/mcp/mcp-service';
import { McpRuntimeRegistry } from '../native-management/mcp/mcp-runtime';
import { createMcpControlService } from '../native-management/mcp/mcp-control-service';
import { registerNativeMcpRoutes } from '../http/settings/native-mcp.routes';
import { createNativePluginService } from '../native-management/plugins/plugin-service';
import { registerNativePluginRoutes } from '../http/settings/native-plugins.routes';
import { registerNativeActionRoutes } from '../http/conversation/native-actions.routes';
import { createNativeActionsService } from '../sessions/native-actions';
import { createClaudeRewindBackend } from '../agents/claude/history/native-actions';
import { createCodexHistoryBackend } from '../agents/codex/history/history-actions';
import { SessionError } from '../agents/errors';

import type { WorkspaceActivity } from '../workspaces/activity';
import type { WorkspaceStore } from '../workspaces/store';

export function createCliServices({
  configDir,
  store,
  activity,
  installationBackend,
  probeRunner,
  agyHistoryScript,
  beforeSessionDelete,
  pluginNativeCommand,
}: {
  configDir: string;
  store: WorkspaceStore;
  activity: WorkspaceActivity;
  installationBackend?: CliInstallationBackend;
  probeRunner?: ProcessRunner;
  agyHistoryScript?: string;
  beforeSessionDelete?: (session: { agent: string; sessionId: string; cwd: string }) => Promise<void>;
  pluginNativeCommand?: (agent: string, name: string) => Promise<boolean>;
}) {
  const acquireWorkspace = (id: string) => activity.acquire(id);
  const attachments = new AttachmentStore(path.join(configDir, 'attachments'));
  const nativeActivity = createCliActivity();
  const mcpRegistry = new McpRuntimeRegistry();
  let antigravityProxyVersion = 0;
  const launchEnvironment = createLaunchEnvironment({
    configDir: configDir,
    onSaved: (agent, names) => {
      if (agent === 'antigravity' && names.some(isAntigravityProxyVariable)) antigravityProxyVersion++;
      return capabilities.invalidate(agent);
    },
  });
  // 官方登录与额度只需要代理覆盖，不解密已保存的 Gemini API Key。
  const antigravityNetworkEnvironment = () => launchEnvironment.resolve('antigravity', isAntigravityProxyVariable);
  const inputFeatures = (agent: AgentKind, input: AttachmentCapabilityInput, signal: AbortSignal) =>
    nativeActivity.run(agent, async () =>
      inputCapabilities(agent, input, await launchEnvironment.resolve(agent), signal),
    );
  const capabilities = createCapabilitiesService(
    {
      claude: withCapabilityDirectory((dir, signal) =>
        nativeActivity.run('claude', async () =>
          discoverClaudeCapabilities(dir, { signal, env: await launchEnvironment.resolve('claude') }),
        ),
      ),
      codex: withCapabilityDirectory((dir, signal) =>
        nativeActivity.run('codex', async () =>
          discoverCodexCapabilities(dir, { signal, env: await launchEnvironment.resolve('codex') }),
        ),
      ),
      antigravity: withCapabilityDirectory((dir, signal) =>
        nativeActivity.run('antigravity', async () =>
          discoverAntigravityCapabilities(dir, { signal, env: await launchEnvironment.resolve('antigravity') }),
        ),
      ),
    },
    // AGY 的启动变量不覆盖 home；只读身份不需要解密环境或等待环境保存队列。
    { configDir, antigravityConnection: readAntigravityConnection, pluginNativeCommand },
  );
  const managementAccess = createNativeManagementAccess({
    withIdleAgent: (agent, operation) => turns.withIdleAgent(agent, operation),
    native: nativeActivity,
    workspace: activity,
  });
  const nativeChanged = async (agent: AgentKind) => {
    await capabilities.invalidate(agent);
    sessions.invalidate(agent);
    await runners[agent].restart();
  };
  const nativeResources = createNativeResourcesService({
    onSaved: nativeChanged,
    withWrite: (...args) => managementAccess.write(...args),
  });
  const nativeManagement = createNativeManagementService({
    environment: (agent) => launchEnvironment.resolve(agent),
    access: managementAccess,
    onChanged: nativeChanged,
  });
  const nativeMcp = createNativeMcpService({
    environment: (agent) => launchEnvironment.resolve(agent),
    access: managementAccess,
    onChanged: nativeChanged,
  });
  const nativePlugins = createNativePluginService({
    environment: (agent) => launchEnvironment.resolve(agent),
    access: managementAccess,
    onChanged: nativeChanged,
    getProject: (id) => store.get(id),
  });
  const mcpControls = createMcpControlService({
    service: nativeMcp,
    registry: mcpRegistry,
    access: managementAccess,
    workspace: { acquire: acquireWorkspace, get: (id) => store.get(id) },
  });
  const antigravityManagement = createAntigravitySessionManagement({
    environment: () => launchEnvironment.resolve('antigravity'),
  });
  // 会话服务与轮次管理器互相引用：会话服务里的回调只在调用时读 turns，声明顺序保持原样。
  const sessions = createSessionsService(
    {
      claude: guardSessionProvider('claude', createClaudeSessions(), nativeActivity),
      antigravity: guardSessionProvider(
        'antigravity',
        createAntigravitySessions({ management: antigravityManagement }),
        nativeActivity,
      ),
      codex: guardSessionProvider(
        'codex',
        {
          capabilities: { rename: true, fork: 'native', delete: 'native', archive: 'native' },
          list: (dir, signal, archived) => listCodexSessions(dir, { signal, archived }),
          page: (dir, input, signal, archived) => pageCodexSessions(dir, input, { signal, archived }),
          read: (id, dir, signal) => readCodexSession(id, dir, { signal }),
          readHistoryPage: (id, dir, before, signal) => readCodexHistoryPage(id, dir, before, { signal }),
          media: (id, dir, locator, signal) => readCodexMedia(id, dir, locator, { signal }),
          subagents: (id, dir, query, signal) => readCodexSubagents(id, dir, query, { signal }),
          assertBelongs: (id, dir, signal) => assertCodexSession(id, dir, { signal }),
          mutate: (id, dir, input) => mutateCodexSession(id, dir, input),
          fork: (id, dir, input) => forkCodexSession(id, dir, input),
        },
        nativeActivity,
      ),
    },
    {
      withIdleSession: (session, operation) => turns.withIdleSession(session, operation),
      isRunning: (s) => turns.isRunning(s),
      // 归属裁决要比较全部项目目录，不能只看当前项目。
      projects: () => store.list(),
      preferences: createSessionPreferences({ configDir: configDir }),
      beforeDelete: beforeSessionDelete,
    },
  );
  const runners = {
    claude: createConfiguredRunner({
      environment: () => launchEnvironment.resolve('claude'),
      create: (env) => createClaudeRunner({ env, mcpRegistry }),
    }),
    codex: createConfiguredRunner({
      environment: () => launchEnvironment.resolve('codex'),
      create: (env) => createCodexRunner({ env, mcpRegistry }),
    }),
    antigravity: createConfiguredRunner({
      environment: () => launchEnvironment.resolve('antigravity'),
      environmentVersion: () => antigravityProxyVersion,
      create: (env) =>
        createAntigravityRunner({
          env,
          readTrajectory: antigravityManagement.readTurnTrajectory?.bind(antigravityManagement),
        }),
    }),
  };
  const turns: TurnManager = new TurnManager({
    getWorkspace: (id) => store.get(id),
    sessions,
    capabilities,
    runners,
    acquireWorkspace,
    attachments,
    inputFeatures,
    references: createSessionReferences({
      configDir,
      store,
      sessions,
      agyHistoryScript,
      environment: (agent) => launchEnvironment.resolve(agent),
    }),
  });
  const installations = createCliInstallationService({
    backend:
      installationBackend ?? createCliInstallationBackend({ environment: (agent) => launchEnvironment.resolve(agent) }),
    withIdleAgent: (agent, operation) => turns.withIdleAgent(agent, () => nativeActivity.exclusive(agent, operation)),
    onChanged: async (agent) => {
      if (agent === 'antigravity') invalidateAntigravityModelCatalog();
      await capabilities.invalidate(agent);
      sessions.invalidate(agent);
    },
    verify: async (agent, installation) => {
      const cli = installation.command;
      if (!cli) return false;
      const env = {
        ...(await launchEnvironment.resolve(agent)),
        AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
        DISABLE_AUTOUPDATER: '1',
      };
      const probes = createAgentProbes({
        run:
          probeRunner ??
          ((_name, args, options) => runProcess(cli.command, [...cli.args, ...args], { ...options, env })),
      });
      return (await probes.probe(agent)).status === 'available';
    },
  });

  const nativeActions = createNativeActionsService({
    withSession: (scope, operation) =>
      turns.withIdleAgent(scope.agent, async () => {
        const release = acquireWorkspace(scope.workspaceId);
        try {
          const workspace = await store.get(scope.workspaceId);
          if (!workspace) throw new SessionError(404, 'workspace_missing', '工作区不存在');
          const native = await sessions.assertBelongs(workspace, scope.agent, scope.sessionId);
          return await nativeActivity.exclusive(scope.agent, () => operation(native ?? workspace));
        } finally {
          release();
        }
      }),
    open: async (scope, workspace) => {
      const env = await launchEnvironment.resolve(scope.agent);
      if (scope.agent === 'claude') return createClaudeRewindBackend(scope.sessionId, workspace.dir, env);
      if (scope.agent === 'codex') return createCodexHistoryBackend(scope.sessionId, workspace.dir, { env });
      throw new SessionError(409, 'native_action_conflict', '当前原生接口没有已核实的回退操作。');
    },
    changed: async (agent) => {
      sessions.invalidate(agent);
      await runners[agent].restart();
      await capabilities.invalidate(agent);
    },
  });

  return {
    sessions,
    turns,
    loginAntigravity: (launch: (env: NodeJS.ProcessEnv) => Promise<boolean>) =>
      nativeActivity.run('antigravity', async () => {
        const env = await antigravityNetworkEnvironment();
        if ((await readAntigravityConnection({ env })) !== 'account') {
          throw new SessionError(409, 'antigravity_account_required', '请先在模型设置中保存 Antigravity 账号登录。');
        }
        const completed = await launch(antigravityLoginEnvironment(env));
        if (completed) await capabilities.invalidate('antigravity');
        return completed;
      }),
    registerAttachments(app: FastifyInstance, recovery: ResumeHub) {
      registerChatAttachmentRoutes(app, {
        attachments,
        recovery,
        acquireWorkspace,
        inputFeatures,
        getWorkspace: (id) => store.get(id),
        assertBelongs: (workspace, agent, id) => sessions.assertBelongs(workspace, agent, id),
      });
    },
    nativeActivity,
    disposeInstallations: () => installations.dispose(),
    disposeSessionManagement: () => {
      mcpControls.oauth.dispose();
      return Promise.all([nativePlugins.dispose(), antigravityManagement.dispose()]).then(() => undefined);
    },
    registerRoutes(a: FastifyInstance) {
      registerNativeActionRoutes(a, nativeActions);
      registerCliInstallationRoutes(a, { service: installations });
      registerSessionRoutes(a, { store, sessions, activity });
      registerCapabilityRoutes(a, {
        store,
        capabilities,
        mainAgents: (dir, sessionId, signal) =>
          nativeActivity.run('antigravity', async () =>
            readAntigravityMainAgents(dir, { sessionId, signal, env: await launchEnvironment.resolve('antigravity') }),
          ),
        sessions,
        runtimeWorkspace: (workspace, session) => turns.capabilityWorkspace(workspace, session),
      });
      registerCodexUsageRoute(a, { store, sessions }, (dir, signal) =>
        nativeActivity.run('codex', async () =>
          readCodexOfficialUsage(dir, { signal, env: await launchEnvironment.resolve('codex') }),
        ),
      );
      registerModelCatalogRoutes(a, { store, capabilities });
      registerAntigravityAccountRoute(a, (signal) =>
        nativeActivity.run('antigravity', async () =>
          readAntigravityAccount({ signal, env: await antigravityNetworkEnvironment() }),
        ),
      );
      registerAntigravityUsageRoute(a, (signal) =>
        nativeActivity.run('antigravity', async () =>
          readAntigravityOfficialUsage({ signal, env: await antigravityNetworkEnvironment() }),
        ),
      );
      const legacyConfig = createNativeConfigService({ onSaved: nativeChanged });
      registerAgentConfigRoutes(a, {
        service: {
          ...legacyConfig,
          save: (agent, input) => managementAccess.write(agent, undefined, () => legacyConfig.save(agent, input)),
        },
      });
      // 项目与 CLI 写租约已在服务内取得，避免 HTTP 包装重复取锁。
      registerNativeResourceRoutes(a, { service: nativeResources, store });
      registerNativeManagementRoutes(a, { service: nativeManagement, store });
      registerNativeMcpRoutes(a, { service: nativeMcp, controls: mcpControls, store });
      registerNativePluginRoutes(a, { service: nativePlugins, store });
      registerModelSettingsRoutes(
        a,
        createModelSettingsService({ resources: nativeResources, environment: launchEnvironment }),
      );
      registerLaunchEnvironmentRoutes(a, {
        service: launchEnvironment,
        restart: (agent) => turns.withIdleAgent(agent, () => runners[agent].restart()),
      });
    },
  };
}
