import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { NativeResourceError } from '../agents/common/configuration/errors';
import { encodeJson } from '../agents/common/configuration/patch';
import {
  inspectDirectory,
  assertDirectoryUnchanged,
  readConfigFile,
  writeConfigFile,
} from '../platform/files/safe-file';
import { nativeFileTransaction } from '../platform/files/transactions';
import type { SkillConfigSource } from './types';

export async function readSkillConfig(file: string, scope: SkillConfigSource['scope']): Promise<SkillConfigSource> {
  const parents = await inspectDirectory(path.dirname(file));
  const snapshot = parents ? await readConfigFile(file) : { content: '', revision: 'missing' };
  if (parents) await assertDirectoryUnchanged(parents);
  let data: unknown = {};
  try {
    if (snapshot.revision !== 'missing')
      data = file.endsWith('.toml') ? parseToml(snapshot.content) : JSON.parse(snapshot.content.replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
  } catch {
    throw new NativeResourceError(file.endsWith('.toml') ? 'invalid_toml' : 'invalid_json');
  }
  return { file, scope, content: snapshot.content, revision: snapshot.revision, data: data as Record<string, unknown> };
}
export async function writeSkillJson(source: SkillConfigSource, mutate: (value: Record<string, unknown>) => void) {
  return nativeFileTransaction(source.file, async () => {
    const parents = await inspectDirectory(path.dirname(source.file), true);
    const previous = await readConfigFile(source.file);
    if (previous.revision !== source.revision) throw new NativeResourceError('revision_conflict');
    const value = structuredClone(source.data);
    mutate(value);
    const data = Buffer.from(encodeJson(source.content, value));
    if (data.length > 256 * 1024) throw new NativeResourceError('too_large');
    await writeConfigFile(source.file, data, previous, parents!);
  });
}
