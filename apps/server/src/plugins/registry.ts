import path from 'node:path';
import { z } from 'zod';
import { WorkbenchPluginManifestSchema, type WorkbenchPluginCatalog } from '@agentdeck/shared/plugins';
import {
  assertDirectoryUnchanged,
  inspectDirectory,
  MAX_CONFIG_BYTES,
  readConfigFile,
  writeConfigFile,
} from '../platform/files/safe-file';
import { WorkbenchPluginError } from './errors';
import { safeRelative } from './files';

const InstalledPluginSchema = z.strictObject({
  manifest: WorkbenchPluginManifestSchema,
  enabled: z.boolean(),
  installedAt: z.number().int().nonnegative(),
  entryRevision: z.string().regex(/^[a-f0-9]{64}$/),
  packageRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
// 旧格式只取实际安装记录；下次保存时移除已退出的内置配置。
const RegistrySchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  plugins: z.array(InstalledPluginSchema).max(64),
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;
export type PluginRegistry = { version: 3; plugins: InstalledPlugin[] };
export type RegistrySnapshot = Awaited<ReturnType<ReturnType<typeof createPluginRegistry>['load']>>;
export function registryCatalog(current: RegistrySnapshot): WorkbenchPluginCatalog {
  return {
    revision: current.snapshot.revision,
    plugins: current.state.plugins.map((entry) => ({
      manifest: entry.manifest,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
    })),
  };
}
export function createPluginRegistry(directory: string) {
  const file = path.join(directory, 'registry.json');
  async function load() {
    const parents = await inspectDirectory(directory);
    const snapshot = parents ? await readConfigFile(file) : { content: '', revision: 'missing' };
    if (parents) await assertDirectoryUnchanged(parents);
    let state: PluginRegistry;
    try {
      const parsed =
        snapshot.revision === 'missing' ? { plugins: [] } : RegistrySchema.parse(JSON.parse(snapshot.content));
      const ids = parsed.plugins.map((entry) => entry.manifest.id);
      if (
        new Set(ids).size !== ids.length ||
        !parsed.plugins.every(({ manifest }) => safeRelative(manifest.id) && safeRelative(manifest.entry))
      )
        throw new Error();
      state = { version: 3, plugins: parsed.plugins };
    } catch {
      throw new WorkbenchPluginError('registry_invalid');
    }
    return { state, snapshot };
  }
  return {
    load,
    async save(state: PluginRegistry, previous: Awaited<ReturnType<typeof load>>['snapshot']) {
      const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf8');
      if (bytes.length > MAX_CONFIG_BYTES) throw new WorkbenchPluginError('too_large');
      const parents = await inspectDirectory(directory, true);
      await writeConfigFile(file, bytes, previous, parents!);
      return load();
    },
  };
}
