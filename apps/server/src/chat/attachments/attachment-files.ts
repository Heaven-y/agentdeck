import { lstat, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ChatAttachmentSchema,
  AttachmentScopeSchema,
  NativeSessionIdSchema,
  type ChatAttachment,
} from '@agentdeck/shared/conversation';
import {
  inspectDirectory,
  assertDirectoryUnchanged,
  readConfigFile,
  writeConfigFile,
} from '../../platform/files/safe-file';
import { attachmentExtension } from './attachment-format';
export const AssetSchema = ChatAttachmentSchema.extend({
  ownerId: z.uuid(),
  scope: AttachmentScopeSchema,
  state: z.enum(['draft', 'pinned', 'embedded']),
  createdAt: z.number().finite(),
  lastUsed: z.number().finite(),
});
export type Asset = z.infer<typeof AssetSchema>;
const Bindings = z.record(z.uuid(), NativeSessionIdSchema).refine((value) => Object.keys(value).length <= 1024);
export class AttachmentFiles {
  constructor(readonly directory: string) {}
  file(asset: ChatAttachment): string {
    return path.join(this.directory, asset.id + attachmentExtension(asset));
  }
  private meta(id: string): string {
    return path.join(this.directory, 'metadata', `${id}.json`);
  }
  async load(): Promise<{ assets: Asset[]; bytes: number }> {
    await inspectDirectory(this.directory, true);
    const metadata = path.join(this.directory, 'metadata');
    await inspectDirectory(metadata, true);
    const assets = await this.readAssets(metadata);
    let bytes = 0;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(this.directory, entry.name);
      bytes += (await lstat(file)).size;
    }
    const snapshot = await readConfigFile(path.join(metadata, 'bindings.json'));
    const bindings = Bindings.parse(snapshot.stat ? JSON.parse(snapshot.content) : {});
    for (const asset of assets) if (bindings[asset.id]) asset.scope.sessionId = bindings[asset.id];
    return { assets, bytes };
  }
  private async readAssets(metadata: string): Promise<Asset[]> {
    const assets: Asset[] = [];
    for (const entry of await readdir(metadata, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(metadata, entry.name);
      if (!z.uuid().safeParse(entry.name.slice(0, -5)).success) continue;
      try {
        const parsed = AssetSchema.safeParse(JSON.parse((await readConfigFile(file)).content));
        if (parsed.success && parsed.data.id === entry.name.slice(0, -5)) assets.push(parsed.data);
      } catch {
        /* 不认领无法验证的遗留文件。 */
      }
    }
    return assets;
  }
  async create(asset: Asset, data: Buffer): Promise<void> {
    const directories = await inspectDirectory(this.directory, true);
    if (!directories) throw new Error('附件目录不可用');
    const handle = await open(this.file(asset), 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await assertDirectoryUnchanged(directories);
      await this.save(asset);
    } catch (error) {
      await assertDirectoryUnchanged(directories);
      await unlink(this.file(asset));
      throw error;
    }
  }
  async save(asset: Asset): Promise<void> {
    const directories = await inspectDirectory(path.dirname(this.meta(asset.id)), true);
    if (!directories) throw new Error('附件目录不可用');
    const meta = this.meta(asset.id);
    await writeConfigFile(meta, Buffer.from(JSON.stringify(asset)), await readConfigFile(meta), directories);
  }
  async bind(assets: Asset[], ids: string[], sessionId: string): Promise<void> {
    const directories = await inspectDirectory(path.join(this.directory, 'metadata'));
    if (!directories) throw new Error('附件目录不可用');
    const file = path.join(this.directory, 'metadata', 'bindings.json');
    const previous = await readConfigFile(file);
    const updates = new Set(ids);
    // 单个有界清单原子替换；不能逐个写scope而让一批附件部分进入新会话。
    const bindings = Bindings.parse(
      Object.fromEntries(
        assets.flatMap((asset) => {
          const target = updates.has(asset.id) ? sessionId : asset.scope.sessionId;
          return target ? [[asset.id, target]] : [];
        }),
      ),
    );
    await writeConfigFile(file, Buffer.from(JSON.stringify(bindings)), previous, directories);
  }
  async remove(asset: Asset): Promise<void> {
    const directories = await inspectDirectory(this.directory);
    if (!directories) throw new Error('附件目录不可用');
    await assertDirectoryUnchanged(directories);
    await unlink(this.file(asset)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await assertDirectoryUnchanged(directories);
    const metadata = await inspectDirectory(path.dirname(this.meta(asset.id)));
    if (!metadata) throw new Error('附件元数据目录不可用');
    await assertDirectoryUnchanged(metadata);
    await unlink(this.meta(asset.id));
  }
}
