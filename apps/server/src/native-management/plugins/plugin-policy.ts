import path from 'node:path';
import { CodexClient } from '../../agents/codex/run/client';
import type { ResourceContext } from '../../agents/common/configuration/resources';
import type { ResolvedCommand } from '../../platform/process/executable';
import { object, string } from './plugin-types';
export type PluginPolicy = {
  verified: boolean;
  enabled: Record<string, unknown>;
  layers: Array<{
    kind: string;
    file?: string;
    version: string;
    disabled: boolean;
    plugins: Record<string, unknown>;
    marketplaces: Record<string, unknown>;
  }>;
};
export async function codexPluginPolicy(c: ResourceContext, command?: ResolvedCommand): Promise<PluginPolicy> {
  const client = await CodexClient.start({ command, env: c.env, cwd: c.project?.dir ?? c.homeDir, timeoutMs: 15000 });
  try {
    await client.initialize();
    const value = await client.request('config/read', { cwd: c.project?.dir ?? c.homeDir, includeLayers: true });
    if (!Array.isArray(value.layers)) return { verified: false, enabled: {}, layers: [] };
    return {
      verified: true,
      enabled: object(object(value.config).plugins),
      layers: value.layers.map((raw) => {
        const layer = object(raw),
          name = object(layer.name),
          config = object(layer.config),
          kind = string(name.type);
        return {
          kind,
          file:
            typeof name.file === 'string'
              ? name.file
              : typeof name.dotCodexFolder === 'string'
                ? path.join(name.dotCodexFolder, 'config.toml')
                : undefined,
          version: string(layer.version),
          disabled: !!layer.disabledReason,
          plugins: object(config.plugins),
          marketplaces: object(config.marketplaces),
        };
      }),
    };
  } finally {
    await client.close();
  }
}
