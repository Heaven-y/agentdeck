import { sshConsoleDefinition } from './manifest';
// 可编程启动：读取配置、组装依赖、只在本机地址上启动，并返回关闭函数。
// CLI（main.ts）与 Electron 桌面壳共用这里，业务路由与清理路径保持原样。
import { registerSshConsoleRoutes } from './http/ssh-console.routes';
import { registerHostTrustRoutes } from './http/ssh-host-trust.routes';
import { registerSshTargetRoutes } from './http/ssh-targets.routes';
import { registerSshRoutes } from './http/ssh.routes';
import { createSshConsoleService } from './console/service';
import { createHostTrust } from './ssh/profiles/host-trust';
import { createPasswordStore } from './ssh/profiles/password-store';
import { createSshPool } from './ssh/transport/pool';
import { createServerProfiles } from './ssh/profiles/profiles';
import { serverHostConfig } from './ssh/profiles/targets';

import type { BuiltinPluginRegistration } from '../../plugins/contracts';
import type { ServerTargets } from './ssh/profiles/targets';

export function createSshConsolePlugin({
  configDir,
  targets,
  isEnabled,
}: {
  configDir: string;
  targets: ServerTargets;
  isEnabled: () => boolean;
}): BuiltinPluginRegistration {
  const pool = createSshPool({
    passwordStore: createPasswordStore({ configDir: configDir }),
    lookupHost: async (alias) => {
      const server = await targets.get(alias);
      return server ? serverHostConfig(server) : undefined;
    },
  });
  const sshConsole = createSshConsoleService({ pool, isEnabled: isEnabled });
  const profiles = createServerProfiles({ targets, pool });
  return {
    ...sshConsoleDefinition,
    registerRoutes(app) {
      registerSshConsoleRoutes(app, sshConsole);
      registerSshRoutes(app, { pool, profiles });
      registerSshTargetRoutes(app, profiles);
      registerHostTrustRoutes(app, createHostTrust({ pool }));
    },
    disable() {
      sshConsole.dispose();
    },
    dispose() {
      sshConsole.dispose();
      pool.dispose();
      return Promise.resolve();
    },
  };
}
