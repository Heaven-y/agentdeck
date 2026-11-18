import { randomUUID, createHash } from 'node:crypto';
import {
  ATTACHMENT_LIMITS,
  AttachmentRefSchema,
  AttachmentScopeSchema,
  NativeSessionIdSchema,
  type ChatAttachment,
  type AttachmentRef,
  type AttachmentScope,
} from '@agentdeck/shared/conversation';
import { readBoundedFile } from '../../platform/files/bounded-file';
import type { NativeAttachment } from '../../agents/contracts';
import { AttachmentFiles, type Asset } from './attachment-files';
import { attachmentError, attachmentFormat } from './attachment-format';
export type PreparedAttachment = NativeAttachment;
export type AttachmentLease = {
  files: PreparedAttachment[];
  bind(sessionId: string): Promise<void>;
  stored(ids: string[]): Promise<void>;
  release(): void;
};
export type AttachmentHold = {
  assets: ChatAttachment[];
  bind(sessionId: string): Promise<void>;
  release(): void;
};
type Options = { maxBytes?: number; now?: () => number };
const publicAsset = ({ id, revision, name, mimeType, size, kind }: Asset): ChatAttachment => ({
  id,
  revision,
  name,
  mimeType,
  size,
  kind,
});
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
/** 本机附件缓存只保存上传资产与归属元数据，不保存对话正文。 */
export class AttachmentStore {
  private readonly disk: AttachmentFiles;
  private readonly owners = new WeakMap<object, string>();
  private readonly assets = new Map<string, Asset>();
  private readonly active = new Map<string, number>();
  private loaded = false;
  private bytes = 0;
  private tail = Promise.resolve();
  private readonly now: () => number;
  private readonly maxBytes: number;
  constructor(directory: string, options: Options = {}) {
    this.disk = new AttachmentFiles(directory);
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? ATTACHMENT_LIMITS.cacheBytes;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    const state = await this.disk.load();
    for (const asset of state.assets) this.assets.set(asset.id, asset);
    this.bytes = state.bytes;
    this.loaded = true;
  }
  private ownerId(owner: object): string {
    let id = this.owners.get(owner);
    if (!id) {
      id = randomUUID();
      this.owners.set(owner, id);
    }
    return id;
  }
  upload(
    owner: object,
    scope: AttachmentScope,
    input: { name: string; mimeType: string; data: Buffer },
  ): Promise<ChatAttachment> {
    return this.serial(async () => {
      AttachmentScopeSchema.parse(scope);
      const format = attachmentFormat(input);
      await this.load();
      await this.prune();
      if (this.bytes + input.data.length > this.maxBytes || this.assets.size >= 1024)
        throw attachmentError('附件缓存已满，请先移除未发送的附件。', 'attachment_capacity');
      const asset: Asset = {
        ...format,
        id: randomUUID(),
        revision: digest(input.data),
        ownerId: this.ownerId(owner),
        scope: { ...scope },
        state: 'draft',
        createdAt: this.now(),
        lastUsed: this.now(),
      };
      await this.disk.create(asset, input.data);
      this.assets.set(asset.id, asset);
      this.bytes += asset.size;
      return publicAsset(asset);
    });
  }
  private selected(owner: object, scope: AttachmentScope, ref: AttachmentRef): Asset {
    AttachmentRefSchema.parse({ id: ref.id, revision: ref.revision });
    const asset = this.assets.get(ref.id);
    if (!asset || asset.ownerId !== this.ownerId(owner) || !sameScope(asset.scope, scope))
      throw attachmentError('附件不属于当前页面或会话。', 'attachment_missing');
    if (asset.revision !== ref.revision) throw attachmentError('附件内容已变化，请重新选择。');
    return asset;
  }
  async preview(owner: object, scope: AttachmentScope, ref: AttachmentRef): Promise<PreparedAttachment> {
    return this.serial(async () => {
      await this.load();
      const asset = this.selected(owner, scope, ref);
      const data = await this.read(asset);
      await this.touch(asset);
      return { ...publicAsset(asset), path: this.disk.file(asset), data };
    });
  }
  inspect(owner: object, scope: AttachmentScope, refs: AttachmentRef[]): Promise<ChatAttachment[]> {
    return this.serial(async () => {
      await this.load();
      const assets = refs.map((ref) => this.selected(owner, scope, ref));
      validateMessage(assets);
      return assets.map(publicAsset);
    });
  }
  remove(owner: object, scope: AttachmentScope, ref: AttachmentRef): Promise<void> {
    return this.serial(async () => {
      await this.load();
      const asset = this.selected(owner, scope, ref);
      if (this.active.has(asset.id) || asset.state !== 'draft')
        throw attachmentError('此附件已用于原生会话，不能作为未发送草稿删除。');
      await this.erase(asset);
    });
  }
  acquire(owner: object, scope: AttachmentScope, refs: AttachmentRef[]): Promise<AttachmentLease> {
    return this.serial(async () => {
      await this.load();
      if (
        !refs.length ||
        refs.length > ATTACHMENT_LIMITS.count ||
        new Set(refs.map((ref) => ref.id)).size !== refs.length
      )
        throw attachmentError('每条消息最多8个不同附件。');
      const assets = refs.map((ref) => this.selected(owner, scope, ref));
      validateMessage(assets);
      const files = await Promise.all(
        assets.map(async (asset) => ({
          ...publicAsset(asset),
          path: this.disk.file(asset),
          data: await this.read(asset),
        })),
      );
      // 在调用原生前固定文件。未确认原生自持久化的输入即使失败也不自动删除。
      for (const asset of assets) await this.update(asset, { state: 'pinned' });
      return {
        ...this.holdAssets(assets),
        files,
        stored: (ids) =>
          this.serial(async () => {
            for (const asset of assets) if (ids.includes(asset.id)) await this.update(asset, { state: 'embedded' });
          }),
      };
    });
  }
  hold(owner: object, scope: AttachmentScope, refs: AttachmentRef[]): Promise<AttachmentHold> {
    return this.serial(async () => {
      await this.load();
      if (
        !refs.length ||
        refs.length > ATTACHMENT_LIMITS.count ||
        new Set(refs.map((ref) => ref.id)).size !== refs.length
      )
        throw attachmentError('每条消息最多8个不同附件。');
      const assets = refs.map((ref) => this.selected(owner, scope, ref));
      validateMessage(assets);
      return this.holdAssets(assets);
    });
  }
  private holdAssets(assets: Asset[]): AttachmentHold {
    for (const asset of assets) this.active.set(asset.id, (this.active.get(asset.id) ?? 0) + 1);
    let released = false;
    return {
      assets: assets.map(publicAsset),
      bind: (sessionId) =>
        this.serial(async () => {
          NativeSessionIdSchema.parse(sessionId);
          if (assets.some((asset) => asset.scope.sessionId && asset.scope.sessionId !== sessionId))
            throw attachmentError('附件已绑定到其他原生会话。');
          await this.disk.bind(
            [...this.assets.values()],
            assets.map((asset) => asset.id),
            sessionId,
          );
          for (const asset of assets) asset.scope = { ...asset.scope, sessionId };
        }),
      release: () => {
        if (released) return;
        released = true;
        for (const asset of assets) {
          const count = this.active.get(asset.id) ?? 0;
          if (count <= 1) this.active.delete(asset.id);
          else this.active.set(asset.id, count - 1);
        }
      },
    };
  }
  private async update(asset: Asset, patch: Partial<Asset>): Promise<void> {
    const next = { ...asset, ...patch, lastUsed: this.now() };
    await this.disk.save(next);
    Object.assign(asset, next);
  }
  private touch(asset: Asset): Promise<void> {
    return this.update(asset, {});
  }
  private async read(asset: Asset): Promise<Buffer> {
    const data = await readBoundedFile(this.disk.file(asset), ATTACHMENT_LIMITS.fileBytes);
    if (data.length !== asset.size || digest(data) !== asset.revision)
      throw attachmentError('附件内容已变化，请重新选择。');
    return data;
  }
  collect(): Promise<void> {
    return this.serial(async () => {
      await this.load();
      await this.prune();
    });
  }
  private async erase(asset: Asset): Promise<void> {
    await this.disk.remove(asset);
    this.assets.delete(asset.id);
    this.bytes -= asset.size;
  }
  private async prune(): Promise<void> {
    for (const asset of this.assets.values()) {
      if (this.active.has(asset.id) || asset.state === 'pinned') continue;
      const lifetime = asset.state === 'draft' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
      if (this.now() - asset.lastUsed >= lifetime) await this.erase(asset);
    }
  }
}
function sameScope(left: AttachmentScope, right: AttachmentScope): boolean {
  if (left.workspaceId !== right.workspaceId || left.agent !== right.agent) return false;
  return left.sessionId
    ? left.sessionId === right.sessionId
    : left.conversationId === right.conversationId && !right.sessionId;
}
function validateMessage(assets: Asset[]): void {
  if (assets.filter((asset) => asset.kind === 'image').length > ATTACHMENT_LIMITS.images)
    throw attachmentError('每条消息最多4张图片。');
  if (assets.reduce((size, asset) => size + asset.size, 0) > ATTACHMENT_LIMITS.messageBytes)
    throw attachmentError('每条消息附件总计最多20 MiB。');
}
