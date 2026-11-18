// 可编程启动：读取配置、组装依赖、只在本机地址上启动，并返回关闭函数。
// CLI（main.ts）与 Electron 桌面壳共用这里，业务路由与清理路径保持原样。
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { AttachmentStore } from '../chat/attachments';
import type { ResumeHub } from '../chat/resume-hub';
import { registerChatAttachmentRoutes } from '../http/chat-attachments.routes';
import { inputCapabilities } from '../chat/input-capabilities';
import type { AgentTurnInput } from '../agents/contracts';
import type { AgentKind } from '@agentdeck/shared/conversation';
import { createCliActivity, guardSessionProvider } from './cli-activity';
import { createAgentProbes, createLocalRunner } from '../agents/common/probe';
import { createCliInstallationBackend } from '../cli-installation';
import type { CliInstallationBackend } from '../cli-installation/types';
import { createCliInstallationService } from '../cli-installation/service';
import { registerCliInstallationRoutes } from '../http/cli-installation.routes';
import type { ProcessRunner } from '../platform/process/run';
import { createAntigravityRunner } from '../agents/antigravity/adapter';
import { invalidateAntigravityModelCatalog } from '../agents/antigravity/context-window';
import { discoverAntigravityCapabilities } from '../agents/antigravity/capabilities';
import { createAntigravitySessionManagement } from '../agents/antigravity/management';
import { createAntigravitySessions } from '../agents/antigravity/sessions';
import { createClaudeRunner } from '../agents/claude/adapter';
import { discoverClaudeCapabilities } from '../agents/claude/capabilities';
import { createClaudeSessions } from '../agents/claude/sessions';
import {
  assertCodexSession,
  createCodexRunner,
  discoverCodexCapabilities,
  forkCodexSession,
  listCodexSessions,
  pageCodexSessions,
  mutateCodexSession,
  readCodexSession,
  readCodexMedia,
  readCodexSubagents,
} from '../agents/codex';
import { withCapabilityDirectory } from '../agents/common/capability-directory';
import { createConfiguredRunner } from '../agents/common/configured-runner';
import { createCapabilitiesService } from '../chat/capabilities';
import { TurnManager } from '../chat/turn-manager';
import { registerAgentConfigRoutes } from '../http/agent-config.routes';
import { registerCapabilityRoutes } from '../http/capabilities.routes';
import { registerLaunchEnvironmentRoutes } from '../http/launch-environment.routes';
import { registerModelCatalogRoutes } from '../http/model-catalog.routes';
import { registerModelSettingsRoutes } from '../http/model-settings.routes';
import { registerNativeResourceRoutes } from '../http/native-resources.routes';
import { registerSessionRoutes } from '../http/sessions.routes';
import { registerSessionToolsRoutes } from '../http/session-tools.routes';
import { createSessionPreferences } from '../sessions/preferences';
import { createSessionsService } from '../sessions/service';
import { createLaunchEnvironment } from '../settings/launch-environment';
import { createModelSettingsService } from '../settings/model-settings';
import { createNativeConfigService } from '../settings/native-config';
import { createNativeResourcesService } from '../settings/native-resources';
import { createSessionToolsService } from '../settings/session-tools';
import { buildSessionToolsCommand } from '../settings/session-tools-command';
import { createNativeManagementAccess } from '../native-management/access';
import { createNativeManagementService } from '../native-management/service';
import { registerNativeManagementRoutes } from '../http/native-management.routes';
import { createNativeMcpService } from '../native-management/mcp-service';
import { McpRuntimeRegistry } from '../native-management/mcp-runtime';
import { createMcpControlService } from '../native-management/mcp-control-service';
import { registerNativeMcpRoutes } from '../http/native-mcp.routes';
import { createNativePluginService } from '../native-management/plugin-service';
import { registerNativePluginRoutes } from '../http/native-plugins.routes';
import { registerNativeActionRoutes } from '../http/native-actions.routes';
import { createNativeActionsService } from '../sessions/native-actions';
import { createClaudeRewindBackend } from '../agents/claude/native-actions';
import { createCodexHistoryBackend } from '../agents/codex/history-actions';
import { SessionError } from '../agents/errors';

import type { WorkspaceActivity } from '../workspaces/activity';
import type { WorkspaceStore } from '../workspaces/store';

export function createCliServices({
  configDir,
  store,
  activity,
  installationBackend,
  probeRunner,
}: {
  configDir: string;
  store: WorkspaceStore;
  activity: WorkspaceActivity;
  installationBackend?: CliInstallationBackend;
  probeRunner?: ProcessRunner;
}) {
  const acquireWorkspace = (id: string) => activity.acquire(id);
  const attachments = new AttachmentStore(path.join(configDir, 'attachments'));
  const nativeActivity = createCliActivity();
  const mcpRegistry = new McpRuntimeRegistry();
  const launchEnvironment = createLaunchEnvironment({
    configDir: configDir,
    onSaved: (agent) => capabilities.invalidate(agent),
  });
  const inputFeatures = (agent: AgentKind, input: AgentTurnInput, signal: AbortSignal) =>
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
    { configDir: configDir },
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
  const sessionToolsCommand = buildSessionToolsCommand(configDir);
  const nativeMcp = createNativeMcpService({
    environment: (agent) => launchEnvironment.resolve(agent),
    access: managementAccess,
    onChanged: nativeChanged,
    sessionToolsCommand,
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
          list: (dir, signal, archived) => listCodexSessions(dir, { signal, archived }),
          page: (dir, input, signal, archived) => pageCodexSessions(dir, input, { signal, archived }),
          read: (id, dir, signal) => readCodexSession(id, dir, { signal }),
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
  });
  const installations = createCliInstallationService({
    backend:
      installationBackend ?? createCliInstallationBackend({ environment: (agent) => launchEnvironment.resolve(agent) }),
    withIdleAgent: (agent, operation) => turns.withIdleAgent(agent, () => nativeActivity.exclusive(agent, operation)),
    restart: (agent) => runners[agent].restart(),
    onChanged: async (agent) => {
      if (agent === 'antigravity') invalidateAntigravityModelCatalog();
      await capabilities.invalidate(agent);
      sessions.invalidate(agent);
    },
    verify: async (agent) => {
      const env = await launchEnvironment.resolve(agent);
      const probes = createAgentProbes({ run: probeRunner ?? createLocalRunner(() => env) });
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
      return scope.agent === 'claude'
        ? createClaudeRewindBackend(scope.sessionId, workspace.dir, env)
        : createCodexHistoryBackend(scope.sessionId, workspace.dir, { env });
    },
    changed: async (agent) => {
      sessions.invalidate(agent);
      await runners[agent].restart();
      await capabilities.invalidate(agent);
    },
  });

  return {
    turns,
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
      registerCapabilityRoutes(a, { store, capabilities, sessions });
      registerModelCatalogRoutes(a, { store, capabilities });
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
      registerSessionToolsRoutes(a, {
        service: createSessionToolsService({
          configDir,
          command: sessionToolsCommand,
          environment: (agent) => launchEnvironment.resolve(agent),
          withIdleAgent: (agent, operation) => turns.withIdleAgent(agent, operation),
          restart: (agent) => runners[agent].restart(),
          onSaved: (agent) => capabilities.invalidate(agent),
        }),
      });
    },
  };
}
