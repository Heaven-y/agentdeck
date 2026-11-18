// 控制台本机夹具：只装配仍然存在的 SSH、服务器档案与控制台路由，用真实 ssh2 服务端验收。
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../../apps/server/src/http/app';
import { registerProjectRoutes } from '../../../apps/server/src/http/projects.routes';
import { registerSshRoutes } from '../../../apps/server/src/builtin-plugins/ssh-console/http/ssh.routes';
import { registerSshConsoleRoutes } from '../../../apps/server/src/builtin-plugins/ssh-console/http/ssh-console.routes';
import { registerSshTargetRoutes } from '../../../apps/server/src/builtin-plugins/ssh-console/http/ssh-targets.routes';
import { createSshConsoleService } from '../../../apps/server/src/builtin-plugins/ssh-console/console/service';
import { createServerProfiles } from '../../../apps/server/src/builtin-plugins/ssh-console/ssh/profiles/profiles';
import { createAgentProbes } from '../../../apps/server/src/agents/common/probe';
import { ProcessError } from '../../../apps/server/src/platform/process/run';
import { createProductSettings } from '../../../apps/server/src/settings/product-settings';
import { registerProductSettingsRoutes } from '../../../apps/server/src/http/settings/product-settings.routes';
import { createResourceFixture } from '../fixtures/resource-fixture';
import { startTerminalFixture } from '../fixtures/terminal-fixture';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ssh-console-'));
  const metrics = createResourceFixture();
  const fixture = await startTerminalFixture({
    configDir: path.join(root, 'config'),
    workspaceDir: path.join(root, 'workspace'),
    exec: metrics.exec,
  });
  const serverId = fixture.targets.list
    ? (await fixture.targets.list())[0]?.alias
    : // 夹具只会登记一台服务器；取不到时明确失败，不猜别名。
      undefined;
  if (!serverId) throw new Error('夹具没有登记服务器');
  const consoleService = createSshConsoleService({ pool: fixture.pool, isEnabled: () => true });
  const profiles = createServerProfiles({
    targets: fixture.targets,
    pool: fixture.pool,
  });
  const token = randomBytes(24).toString('hex');
  const app = await buildApp({
    token,
    port: 0,
    webDir: fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
    routes: (server) => {
      registerProjectRoutes(server, { store: fixture.store });
      registerSshRoutes(server, { pool: fixture.pool, profiles });
      registerSshTargetRoutes(server, profiles);
      registerSshConsoleRoutes(server, consoleService);
      registerProductSettingsRoutes(
        server,
        createProductSettings({ configDir: path.join(root, 'config') }),
        createAgentProbes({
          // 夹具不启动真实 CLI；环境接口固定按“未找到”返回，避免依赖测试机安装。
          run: () => Promise.reject(new ProcessError('executable_missing', '控制台夹具不探测本机 CLI')),
        }),
      );
      server.get('/api/projects/:id/sessions', () => Promise.resolve([]));
      server.get('/__fixture', () => Promise.resolve({ shells: fixture.shells, resources: metrics.state }));
      server.post<{ Body: { failure: boolean } }>('/__fixture/resource-failure', (req) => {
        metrics.state.failure = req.body.failure;
        return metrics.state;
      });
      server.get('/__fixture/server', () => Promise.resolve({ serverId }));
      server.get('/ws', { websocket: true }, (socket) => {
        socket.on('error', () => undefined);
        socket.on('message', (data) => socket.send(data));
      });
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  console.log(`SSH Console 验收地址：${app.listeningOrigin}/（服务器别名 ${serverId}）`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    consoleService.dispose();
    await app.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  };
  process.once('SIGINT', () => {
    void close();
  });
  process.once('SIGTERM', () => {
    void close();
  });
}
main().catch(() => {
  console.error('SSH Console 本机夹具启动失败');
  process.exitCode = 1;
});
