import { WorkbenchPluginManifestSchema, type WorkbenchPluginManifest } from '@agentdeck/shared/plugins';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertDirectoryUnchanged, decodeUtf8, inspectDirectory } from '../platform/files/safe-file';
import { WorkbenchPluginError } from './errors';
import {
  childPath,
  enumeratePluginFiles,
  MAX_PLUGIN_BYTES,
  readPluginFile,
  removePluginDirectory,
  safeRelative,
  statIfPresent,
} from './files';

export const MANIFEST_FILE = 'agentdeck.plugin.json';
const STATIC_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.css',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
]);
export type PluginPackage = { manifest: WorkbenchPluginManifest; files: Map<string, Buffer> };

function allowedAsset(relative: string, backend?: string): boolean {
  if (relative === MANIFEST_FILE) return true;
  if (relative === backend) return true;
  const parts = relative.split('/');
  if (parts.some((part) => part.startsWith('.') || /^(?:node_modules|credentials?|secrets?|auth|tokens?)$/i.test(part)))
    return false;
  return STATIC_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

function packageManifest(files: Map<string, Buffer>): WorkbenchPluginManifest {
  try {
    const raw = files.get(MANIFEST_FILE);
    if (!raw || raw.length > 64 * 1024) throw new Error();
    const manifest = WorkbenchPluginManifestSchema.parse(JSON.parse(decodeUtf8(raw)));
    if (!safeRelative(manifest.entry) || !files.has(manifest.entry) || !safeRelative(manifest.id)) throw new Error();
    decodeUtf8(files.get(manifest.entry)!);
    if (manifest.apiVersion === 2 && (!safeRelative(manifest.backend) || !files.has(manifest.backend)))
      throw new Error();
    return manifest;
  } catch {
    throw new WorkbenchPluginError('invalid_manifest');
  }
}

export async function readPluginPackage(directory: string): Promise<PluginPackage> {
  if (!path.isAbsolute(directory) || directory.startsWith('\\\\') || directory.startsWith('//'))
    throw new WorkbenchPluginError('invalid_request');
  const root = path.resolve(directory);
  const files = new Map<string, Buffer>();
  let bytes = 0;
  for (const relative of await enumeratePluginFiles(root)) {
    const content = await readPluginFile(childPath(root, relative), MAX_PLUGIN_BYTES - bytes);
    bytes += content.length;
    if (bytes > MAX_PLUGIN_BYTES) throw new WorkbenchPluginError('too_large');
    files.set(relative, content);
  }
  const manifest = packageManifest(files);
  for (const file of files.keys())
    if (!allowedAsset(file, manifest.apiVersion === 2 ? manifest.backend : undefined))
      throw new WorkbenchPluginError('package_rejected');
  return { manifest, files };
}

/** 后端执行前核对整个包，页面和服务使用同一安装快照。 */
export function packageRevision(source: PluginPackage): string {
  const hash = createHash('sha256');
  for (const [name, bytes] of [...source.files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([name, bytes.length]));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export async function copyPluginPackage(directory: string, source: PluginPackage) {
  const parent = await inspectDirectory(path.dirname(directory), true);
  if (await statIfPresent(directory)) throw new WorkbenchPluginError('already_installed');
  await assertDirectoryUnchanged(parent!);
  await mkdir(directory, { mode: 0o700 });
  const identity = await lstat(directory);
  try {
    for (const [relative, bytes] of source.files) {
      const file = childPath(directory, relative);
      const parents = await inspectDirectory(path.dirname(file), true);
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertDirectoryUnchanged(parents!);
    }
    return identity;
  } catch (error) {
    await removePluginDirectory(directory, identity);
    throw error;
  }
}
