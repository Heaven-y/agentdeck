import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { AgentKind } from '@agentdeck/shared/conversation';
import { inspectDirectory, MAX_CONFIG_BYTES, readConfigFile, writeConfigFile } from '../../platform/files/safe-file';

const Model = z.object({
  id: z.string().min(1).max(512),
  label: z.string().max(512),
  description: z.string().max(2048).optional(),
  modelId: z.string().min(1).max(512).optional(),
  reasoningEfforts: z.array(z.string().max(100)).max(16).optional(),
  defaultReasoningEffort: z.string().min(1).max(100).optional(),
  inputModalities: z.array(z.string().min(1).max(64)).max(32).optional(),
});
const Models = z.array(Model);
const ModelCatalog = z.object({
  models: Models,
  defaultModel: z.string().min(1).max(512).optional(),
  defaultReasoningEffort: z.string().min(1).max(100).optional(),
});
type Catalogs = Array<ModelCatalogSnapshot & { key: string }>;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const AGY_IDENTITY_VERSION = 2;
const Stored = z.strictObject({
  version: z.literal(3),
  identityVersion: z.literal(AGY_IDENTITY_VERSION).optional(),
  directories: z.array(z.strictObject({ key: Digest, catalog: Digest })).max(32),
  catalogs: z.array(ModelCatalog.extend({ id: Digest }).strict()).max(32),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const EMPTY_CACHE = '{"version":3,"directories":[],"catalogs":[]}\n';
export type ModelCatalogSnapshot = z.infer<typeof ModelCatalog>;
export type ModelCacheWriteGuard = { currentRequest: () => boolean; currentScope?: () => Promise<boolean> };

/** 不合并目录作用域；仅对已解析的公开模型快照做内容去重。 */
function encode(catalogs: Catalogs, agent: AgentKind): Buffer {
  const unique = new Map<string, ModelCatalogSnapshot>();
  const directories = catalogs.map(({ key, ...catalog }) => {
    const identity = hash(JSON.stringify(catalog));
    unique.set(identity, catalog);
    return { key, catalog: identity };
  });
  const content = {
    version: 3,
    ...(agent === 'antigravity' ? { identityVersion: AGY_IDENTITY_VERSION } : {}),
    directories,
    catalogs: [...unique].map(([id, catalog]) => ({ id, ...catalog })),
  };
  return Buffer.from(JSON.stringify(content) + '\n');
}
function bounded(catalogs: Catalogs, agent: AgentKind): Buffer | undefined {
  while (catalogs.length > 0) {
    const bytes = encode(catalogs, agent);
    if (bytes.length <= MAX_CONFIG_BYTES) return bytes;
    catalogs.shift();
  }
  return undefined;
}
function decode(content: string, agent: AgentKind): Catalogs {
  const data = Stored.parse(JSON.parse(content));
  // 旧 v3 即使有模型身份版本，也没有 AGY 连接身份，不能归给当前模式。
  const modeAware = data.identityVersion === AGY_IDENTITY_VERSION;
  if (modeAware !== (agent === 'antigravity')) return [];
  const snapshots = new Map(data.catalogs.map(({ id, ...catalog }) => [id, catalog]));
  return data.directories.map(({ key, catalog }) => {
    const snapshot = snapshots.get(catalog);
    if (!snapshot) throw new Error('模型缓存引用缺失');
    return { key, ...snapshot };
  });
}

/** 只缓存模型元数据，目录用摘要标识；技能路径、诊断与认证材料不写入。 */
export function createModelCache(configDir: string) {
  const directory = path.join(path.resolve(configDir), 'model-cache');
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T | undefined> => {
    // 缓存不可用不能阻断 CLI 使用，也不把文件诊断回传给界面。
    const pending = queue.then(action, action).catch(() => undefined);
    queue = pending;
    return pending;
  };
  async function load(agent: AgentKind) {
    const parents = await inspectDirectory(directory);
    const file = path.join(directory, `${agent}.json`);
    const snapshot = parents ? await readConfigFile(file) : { content: '', revision: 'missing' };
    let catalogs: Catalogs = [];
    try {
      catalogs = decode(snapshot.content, agent);
    } catch {
      // 派生缓存可由下一次成功发现重建，不把损坏内容当作已获取模型。
    }
    return { file, snapshot, catalogs };
  }
  async function commit(
    current: Awaited<ReturnType<typeof load>>,
    bytes: Buffer,
    { currentRequest, currentScope }: ModelCacheWriteGuard,
  ) {
    const parents = await inspectDirectory(directory, true);
    if ((currentScope && !(await currentScope())) || !currentRequest()) return;
    await writeConfigFile(current.file, bytes, current.snapshot, parents!);
    // 写入期间连接可能已切换，请求也可能被取消或替代；同一队列内还原后再放行新写入。
    if ((currentScope && !(await currentScope())) || !currentRequest()) {
      const updated = await readConfigFile(current.file);
      const previous = current.snapshot.content || EMPTY_CACHE;
      await writeConfigFile(current.file, Buffer.from(previous), updated, parents!);
    }
  }
  return {
    read: (agent: AgentKind, key: string) =>
      serial(async () => {
        const stored = await load(agent);
        const catalog = stored.catalogs.find((entry) => entry.key === hash(key));
        return catalog && ModelCatalog.parse(catalog);
      }),
    write: (agent: AgentKind, key: string, catalog: ModelCatalogSnapshot, guard: ModelCacheWriteGuard) =>
      serial(async () => {
        const parsed = ModelCatalog.safeParse(catalog);
        if (!parsed.success || !guard.currentRequest()) return;
        const current = await load(agent);
        const identity = hash(key);
        const catalogs = current.catalogs.filter((catalog) => catalog.key !== identity).slice(-31);
        catalogs.push({ key: identity, ...parsed.data });
        const bytes = bounded(catalogs, agent);
        if (bytes) await commit(current, bytes, guard);
      }),
    invalidate: (agent: AgentKind) =>
      serial(async () => {
        const current = await load(agent);
        if (current.snapshot.revision === 'missing') return;
        const parents = await inspectDirectory(directory);
        await writeConfigFile(current.file, Buffer.from(EMPTY_CACHE), current.snapshot, parents!);
      }),
  };
}
