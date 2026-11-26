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
    nativeCommand: (agent: string, name: string) => service.nativeCommand(agent, name),
    beforeSessionDelete: (session: Parameters<typeof service.beforeSessionDelete>[0]) =>
      service.beforeSessionDelete(session),
    registerRoutes: (app: FastifyInstance) => registerPluginRoutes(app, { service }),
    dispose: () => service.dispose(),
  };
}
