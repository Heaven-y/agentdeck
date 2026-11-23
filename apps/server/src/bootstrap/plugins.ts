import type { FastifyInstance } from 'fastify';
import { registerPluginRoutes } from '../http/plugins.routes';
import { createWorkbenchPlugins } from '../plugins/service';
import type { WorkbenchPluginHostRequest } from '@agentdeck/shared/plugins';
export async function createPlugins(
  configDir: string,
  host?: (input: WorkbenchPluginHostRequest, signal?: AbortSignal) => Promise<unknown>,
) {
  const service = createWorkbenchPlugins({ configDir, host });
  await service.list();
  return {
    registerRoutes: (app: FastifyInstance) => registerPluginRoutes(app, { service }),
    dispose: () => service.dispose(),
  };
}
