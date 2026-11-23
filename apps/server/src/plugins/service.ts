import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import type {
  WorkbenchPluginBackendRequest,
  WorkbenchPluginCatalog,
  WorkbenchPluginInstallInput,
  WorkbenchPluginPage,
  WorkbenchPluginRemoveInput,
  WorkbenchPluginStorage,
  WorkbenchPluginStorageInput,
  WorkbenchPluginUpdateInput,
} from '@agentdeck/shared/plugins';
import { contentRevision, decodeUtf8 } from '../platform/files/safe-file';
import { WorkbenchPluginError, pluginError } from './errors';
import { childPath, readPluginFile } from './files';
import { copyPluginPackage, packageRevision, readPluginPackage } from './package';
import { removePluginDirectory } from './files';
import { createPluginRegistry, registryCatalog, type RegistrySnapshot, type InstalledPlugin } from './registry';
import { createPluginStorage } from './storage';
import { PluginBackend } from './backend';

type Deps = { configDir: string };
function assertRevision(current: RegistrySnapshot, revision: string) {
  if (current.snapshot.revision !== revision) throw new WorkbenchPluginError('revision_conflict');
}
function findPlugin(current: RegistrySnapshot, id: string): InstalledPlugin {
  const entry = current.state.plugins.find((plugin) => plugin.manifest.id === id);
  if (!entry) throw new WorkbenchPluginError('plugin_missing');
  return entry;
}
function replacing(current: RegistrySnapshot, id: string, revision?: string) {
  const previous = current.state.plugins.find((entry) => entry.manifest.id === id);
  if (previous) {
    if (!revision) throw new WorkbenchPluginError('already_installed');
    assertRevision(current, revision);
  } else if (current.state.plugins.length >= 64) throw new WorkbenchPluginError('too_large');
  return previous;
}
export function createWorkbenchPlugins(deps: Deps) {
  const directory = path.resolve(deps.configDir, 'workbench-plugins');
  const packages = path.join(directory, 'packages');
  const registry = createPluginRegistry(directory);
  const storage = createPluginStorage(path.join(directory, 'storage'));
  const runtimes = new Map<string, PluginBackend>();
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(() => {
      if (disposed) throw new WorkbenchPluginError('plugin_disabled');
      return operation();
    });
    queue = run.catch(() => undefined);
    return run.catch((error: unknown) => {
      throw pluginError(error);
    });
  }
  async function stop(id: string) {
    const runtime = runtimes.get(id);
    runtimes.delete(id);
    await runtime?.dispose();
  }
  async function active(id: string) {
    const entry = findPlugin(await registry.load(), id);
    if (!entry.enabled) throw new WorkbenchPluginError('plugin_disabled');
    return entry;
  }
  async function checked(entry: InstalledPlugin) {
    const files = await readPluginPackage(childPath(packages, entry.manifest.id));
    if (entry.manifest.apiVersion === 2 && (!entry.packageRevision || packageRevision(files) !== entry.packageRevision))
      throw new WorkbenchPluginError('unsafe_path');
    if (contentRevision(files.files.get(entry.manifest.entry)!) !== entry.entryRevision)
      throw new WorkbenchPluginError('unsafe_path');
    return files;
  }
  async function withStorage(id: string) {
    if (!(await active(id)).manifest.permissions.includes('storage'))
      throw new WorkbenchPluginError('permission_denied');
  }
  return {
    list: (): Promise<WorkbenchPluginCatalog> => serial(async () => registryCatalog(await registry.load())),
    install(input: WorkbenchPluginInstallInput): Promise<WorkbenchPluginCatalog> {
      return serial(async () => {
        const current = await registry.load();
        const source = await readPluginPackage(input.directory);
        const previous = replacing(current, source.manifest.id, input.revision);
        const id = source.manifest.id;
        const target = childPath(packages, id);
        const staged = childPath(packages, `${id}-staged-${randomUUID()}`);
        const backup = childPath(packages, `${id}-previous-${randomUUID()}`);
        await copyPluginPackage(staged, source);
        let backedUp = false;
        let replaced = false;
        let committed = false;
        try {
          if (previous) {
            await stop(id);
            await rename(target, backup);
            backedUp = true;
          }
          await rename(staged, target);
          replaced = true;
          const entry: InstalledPlugin = {
            manifest: source.manifest,
            enabled:
              previous?.enabled === true &&
              source.manifest.permissions.every((permission) => previous.manifest.permissions.includes(permission)),
            installedAt: Date.now(),
            entryRevision: contentRevision(source.files.get(source.manifest.entry)!),
            packageRevision: packageRevision(source),
          };
          current.state.plugins = previous
            ? current.state.plugins.map((item) => (item.manifest.id === id ? entry : item))
            : [...current.state.plugins, entry];
          const saved = await registry.save(current.state, current.snapshot);
          committed = true;
          if (backedUp) await removePluginDirectory(backup);
          return registryCatalog(saved);
        } catch (error) {
          if (committed) throw error;
          if (replaced) await removePluginDirectory(target);
          if (backedUp) await rename(backup, target);
          await removePluginDirectory(staged);
          throw error;
        }
      });
    },
    update(id: string, input: WorkbenchPluginUpdateInput): Promise<WorkbenchPluginCatalog> {
      return serial(async () => {
        const current = await registry.load();
        assertRevision(current, input.revision);
        const entry = findPlugin(current, id);
        if (entry.enabled === input.enabled) return registryCatalog(current);
        if (input.enabled) await checked(entry);
        else await stop(id);
        entry.enabled = input.enabled;
        return registryCatalog(await registry.save(current.state, current.snapshot));
      });
    },
    remove(id: string, input: WorkbenchPluginRemoveInput): Promise<WorkbenchPluginCatalog> {
      return serial(async () => {
        let current = await registry.load();
        assertRevision(current, input.revision);
        const entry = findPlugin(current, id);
        await stop(id);
        entry.enabled = false;
        current = await registry.save(current.state, current.snapshot);
        await removePluginDirectory(childPath(packages, id));
        if (entry.manifest.apiVersion === 1) await storage.remove(id);
        current.state.plugins = current.state.plugins.filter((item) => item.manifest.id !== id);
        return registryCatalog(await registry.save(current.state, current.snapshot));
      });
    },
    page(id: string): Promise<WorkbenchPluginPage> {
      return serial(async () => {
        const entry = await active(id);
        if (entry.manifest.apiVersion === 2) await checked(entry);
        const bytes = await readPluginFile(childPath(childPath(packages, id), entry.manifest.entry));
        if (contentRevision(bytes) !== entry.entryRevision) throw new WorkbenchPluginError('unsafe_path');
        return { html: decodeUtf8(bytes) };
      });
    },
    async backend(id: string, input: WorkbenchPluginBackendRequest, signal?: AbortSignal) {
      const runtime = await serial(async () => {
        const entry = await active(id);
        if (entry.manifest.apiVersion !== 2 || !entry.manifest.permissions.includes('backend'))
          throw new WorkbenchPluginError('permission_denied');
        let value = runtimes.get(id);
        if (value && !value.alive) {
          await value.dispose();
          runtimes.delete(id);
          value = undefined;
        }
        if (!value) {
          await checked(entry);
          value = await PluginBackend.start(childPath(childPath(packages, id), entry.manifest.backend), {
            dataDir: childPath(path.join(directory, 'data'), id),
            hostDataDir: deps.configDir,
          });
          runtimes.set(id, value);
        }
        return value;
      });
      return runtime.request(input, signal);
    },
    readStorage(id: string): Promise<WorkbenchPluginStorage> {
      return serial(async () => {
        await withStorage(id);
        return storage.read(id);
      });
    },
    saveStorage(id: string, input: WorkbenchPluginStorageInput): Promise<WorkbenchPluginStorage> {
      return serial(async () => {
        await withStorage(id);
        return storage.save(id, input);
      });
    },
    async dispose() {
      disposed = true;
      await queue;
      await Promise.all([...runtimes.keys()].map(stop));
    },
  };
}
export type WorkbenchPluginsService = ReturnType<typeof createWorkbenchPlugins>;
