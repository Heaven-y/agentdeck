import type { FastifyInstance } from 'fastify';
import { registerPluginRoutes } from '../http/plugins.routes';
import { createWorkbenchPlugins } from '../plugins/service';
export async function createPlugins(configDir: string) {
  const service = createWorkbenchPlugins({ configDir });
  await service.list();
  return {
    registerRoutes: (app: FastifyInstance) => registerPluginRoutes(app, { service }),
    dispose: () => service.dispose(),
  };
}
