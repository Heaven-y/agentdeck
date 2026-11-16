import type { FastifyInstance } from 'fastify';
import { createSshConsolePlugin } from '../builtin-plugins/ssh-console/registration';
import { sshConsoleDefinition } from '../builtin-plugins/ssh-console/manifest';
import { createServerTargets } from '../builtin-plugins/ssh-console/ssh/targets';
import { registerPluginRoutes } from '../http/plugins.routes';
import type { BuiltinPluginRegistration } from '../plugins/contracts';
import { createWorkbenchPlugins } from '../plugins/service';

export async function createBuiltinPlugins(deps: { configDir: string; logError(message: string): void }) {
  const targets = createServerTargets({ configDir: deps.configDir });
  const registrations: BuiltinPluginRegistration[] = [];
  const plugins = createWorkbenchPlugins({
    configDir: deps.configDir,
    builtins: [sshConsoleDefinition],
    onDisable: (id) => registrations.find((entry) => entry.manifest.id === id)?.disable(),
  });
  registrations.push(
    createSshConsolePlugin({
      configDir: deps.configDir,
      targets,
      isEnabled: () => plugins.isEnabled(sshConsoleDefinition.manifest.id),
    }),
  );
  await plugins.list();
  return {
    registerRoutes(app: FastifyInstance) {
      registerPluginRoutes(app, { service: plugins });
      for (const registration of registrations) {
        void app.register((scope, _options, registered) => {
          scope.addHook('onRequest', (_req, reply, done) => {
            if (!plugins.isEnabled(registration.manifest.id)) {
              void reply.code(409).send({ code: 'plugin_disabled', message: `${registration.manifest.name} 已停用` });
              return;
            }
            done();
          });
          registration.registerRoutes(scope);
          registered();
        });
      }
    },
    dispose: async () => {
      await Promise.allSettled(registrations.map((entry) => Promise.resolve().then(() => entry.dispose())));
    },
  };
}
