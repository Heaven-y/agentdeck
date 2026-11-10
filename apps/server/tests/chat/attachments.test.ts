import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AttachmentFiles } from '../../src/chat/attachment-files';
import * as safeFile from '../../src/platform/files/safe-file';
import { AttachmentStore } from '../../src/chat/attachments';
import { TurnManager, type Socket } from '../../src/chat/turn-manager';
import { nativeFeaturesFor, type ServerMessage } from '@agentdeck/shared/conversation';
const directories: string[] = [];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=',
  'base64',
);
const scope = { workspaceId: 'workspace', agent: 'claude' as const, conversationId: 'draft' };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
it('JSON附件数据与元数据分开保存，重启按真实字节计容量且草稿可以删除', async () => {
  const { root, store } = await setup();
  const owner = {},
    data = Buffer.from('{"value":"fixture"}');
  const asset = await store.upload(owner, scope, { name: 'notes.json', mimeType: 'application/json', data });
  expect((await store.preview(owner, scope, asset)).data).toEqual(data);
  const disk = new AttachmentFiles(root);
  expect((await disk.load()).bytes).toBe(data.length);
  const restarted = new AttachmentStore(root, { maxBytes: data.length, now: () => 2 });
  await expect(restarted.upload({}, scope, { name: 'more.txt', mimeType: '', data: Buffer.from('x') })).rejects.toThrow(
    '已满',
  );
  await store.remove(owner, scope, asset);
  expect((await disk.load()).bytes).toBe(0);
});
it('整批原生会话绑定只有一次原子提交，提交失败时全部保留原范围，重启读回全部一致', async () => {
  const { root, store } = await setup();
  const owner = {};
  const assets = await Promise.all(
    ['one.txt', 'two.txt'].map((name) => store.upload(owner, scope, { name, mimeType: '', data: Buffer.from(name) })),
  );
  const lease = await store.acquire(owner, scope, assets);
  const original = safeFile.writeConfigFile;
  const write = vi.spyOn(safeFile, 'writeConfigFile');
  write.mockImplementation(async (...args) => {
    if (write.mock.calls.length === 1) throw new Error('合成原子提交失败');
    return original(...args);
  });
  await expect(lease.bind('native')).rejects.toThrow();
  vi.restoreAllMocks();
  for (const asset of assets) expect((await store.preview(owner, scope, asset)).name).toBe(asset.name);
  const successful = vi.spyOn(safeFile, 'writeConfigFile');
  await lease.bind('native');
  expect(successful).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
  const loaded = await new AttachmentFiles(root).load();
  expect(loaded.assets.map((asset) => asset.scope.sessionId)).toEqual(['native', 'native']);
  for (const asset of assets)
    expect((await store.preview(owner, { ...scope, sessionId: 'native' }, asset)).name).toBe(asset.name);
  lease.release();
});
it('轮次等待附件整批绑定，绑定失败明确拒绝输入并停止，不发布虚假的成功会话', async () => {
  const { store, root } = await setup();
  const sent: ServerMessage[] = [];
  const socket: Socket = { send: (message) => sent.push(message), isOpen: () => true };
  const assets = await Promise.all(
    ['one.txt', 'two.txt'].map((name) => store.upload(socket, scope, { name, mimeType: '', data: Buffer.from(name) })),
  );
  let rejectBinding!: (error: Error) => void;
  vi.spyOn(AttachmentFiles.prototype, 'bind').mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectBinding = reject;
      }),
  );
  const interrupt = vi.fn(async () => {});
  const turns = new TurnManager({
    getWorkspace: async () => ({ id: scope.workspaceId, name: 'fixture', dir: root }),
    sessions: { assertBelongs: async () => {} },
    attachments: store,
    inputFeatures: async () =>
      nativeFeaturesFor('claude', {
        runtime: 'claude-sdk',
        handshake: 'confirmed',
        cliVersion: '2.1.317',
        sdkVersion: '0.3.286',
        implemented: ['documents'],
      }),
    runners: {
      claude: (input) => {
        input.emit({ type: 'session', sessionId: 'native', cwd: root, agent: 'claude', model: 'fixture' });
        input.emit({ type: 'text', delta: '不可在绑定失败后显示的成功正文' });
        input.emit({ type: 'turn_end', isError: false });
        return { done: Promise.resolve(), interrupt };
      },
    },
  });
  try {
    await turns.handle(socket, {
      type: 'chat.send',
      ...scope,
      text: '发送文件',
      clientTurnId: 'send',
      attachments: assets.map(({ id, revision }) => ({ id, revision })),
    });
    await vi.waitFor(() => expect(rejectBinding).toBeTypeOf('function'));
    expect(turns.isRunning({ agent: 'claude', sessionId: 'native' })).toBe(true);
    expect(sent.some((message) => message.type === 'agent.event' && message.event.type === 'session')).toBe(false);
    rejectBinding(new Error('合成绑定写入失败'));
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'turn.finished')).toBe(true));
    expect(sent.some((message) => message.type === 'input.rejected')).toBe(true);
    expect(
      sent.some(
        (message) => message.type === 'agent.event' && message.event.type === 'turn_end' && message.event.isError,
      ),
    ).toBe(true);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(turns.isRunning({ agent: 'claude', sessionId: 'native' })).toBe(false);
    for (const asset of assets) expect((await store.preview(socket, scope, asset)).name).toBe(asset.name);
  } finally {
    await turns.dispose();
  }
});
async function setup(maxBytes?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-attachments-'));
  directories.push(root);
  let now = 1;
  return {
    store: new AttachmentStore(root, { maxBytes, now: () => now }),
    root,
    tick: (ms: number) => {
      now += ms;
    },
  };
}
it('发送前收紧实际能力，拒绝时附件仍是可移除草稿；受理后只把元数据放入回放', async () => {
  const { store } = await setup();
  const sent: ServerMessage[] = [];
  const socket: Socket = { send: (message) => sent.push(message), isOpen: () => true };
  const uploaded = await store.upload(socket, scope, { name: 'photo.png', mimeType: 'image/png', data: png });
  let supported = false;
  let received: Buffer | undefined;
  const turns = new TurnManager({
    getWorkspace: async () => ({ id: scope.workspaceId, name: 'fixture', dir: process.cwd() }),
    sessions: { assertBelongs: async () => {} },
    attachments: store,
    inputFeatures: async () =>
      nativeFeaturesFor(
        'claude',
        supported
          ? {
              runtime: 'claude-sdk',
              cliVersion: '2.1.317',
              sdkVersion: '0.3.286',
              handshake: 'confirmed',
              implemented: ['images'],
            }
          : undefined,
      ),
    runners: {
      claude: (input) => {
        received = input.attachments?.[0]?.data;
        return { interrupt: async () => {}, done: Promise.resolve() };
      },
    },
  });
  try {
    const message = {
      type: 'chat.send' as const,
      ...scope,
      clientTurnId: 'first',
      text: '',
      attachments: [{ id: uploaded.id, revision: uploaded.revision }],
    };
    await turns.handle(socket, message);
    expect(sent.some((message) => message.type === 'input.rejected')).toBe(true);
    expect(received).toBeUndefined();
    supported = true;
    await turns.handle(socket, { ...message, clientTurnId: 'second' });
    expect(received).toEqual(png);
    expect(JSON.stringify(sent)).not.toContain(png.toString('base64'));
  } finally {
    await turns.dispose();
  }
});
it('重启保留已发送文件引用并回收过期草稿，不重新认领旧页面身份或损坏元数据', async () => {
  const { store, root } = await setup();
  const owner = {};
  const draft = await store.upload(owner, scope, { name: 'draft.txt', mimeType: '', data: Buffer.from('草稿') });
  const pinned = await store.upload(owner, scope, { name: 'notes.txt', mimeType: '', data: Buffer.from('固定引用') });
  const lease = await store.acquire(owner, scope, [pinned]);
  await lease.bind('native');
  lease.release();
  lease.release();
  await writeFile(path.join(root, 'metadata', 'invalid.json'), '{}');
  await writeFile(path.join(root, 'metadata', '00000000-0000-4000-8000-000000000004.json'), '{');
  await mkdir(path.join(root, 'unrelated'));
  const restarted = new AttachmentStore(root, { now: () => 9 * 24 * 60 * 60 * 1000 });
  await restarted.collect();
  expect(await readdir(root)).not.toContain(`${draft.id}.txt`);
  expect(await readFile(lease.files[0]!.path, 'utf8')).toBe('固定引用');
  await expect(restarted.preview(owner, { ...scope, sessionId: 'native' }, pinned)).rejects.toThrow('页面或会话');
  const current = await restarted.upload(owner, scope, {
    name: 'current.txt',
    mimeType: '',
    data: Buffer.from('新草稿'),
  });
  await restarted.remove(owner, scope, current);
  expect(await readdir(root)).not.toContain(`${current.id}.txt`);
});
it('资产读取拒绝外部修改与目录链接，不能从原生文件引用越过本机读取边界', async () => {
  const { store, root } = await setup();
  const owner = {};
  const asset = await store.upload(owner, scope, { name: 'notes.txt', mimeType: '', data: Buffer.from('original') });
  await writeFile(path.join(root, `${asset.id}.txt`), 'tampered');
  await expect(store.preview(owner, scope, asset)).rejects.toThrow('变化');
  const other = path.join(root, 'other');
  await mkdir(other);
  const linked = path.join(root, 'linked');
  await symlink(other, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const unsafe = new AttachmentStore(linked);
  await expect(
    unsafe.upload(owner, scope, { name: 'notes.txt', mimeType: '', data: Buffer.from('x') }),
  ).rejects.toThrow();
});
it('上传验证实际格式及文件名，不能以扩展名伪装图片或写入路径', async () => {
  const { store } = await setup();
  const owner = {};
  await expect(
    store.upload(owner, scope, { name: '../escape.png', mimeType: 'image/png', data: png }),
  ).rejects.toThrow();
  await expect(
    store.upload(owner, scope, { name: 'fake.png', mimeType: 'image/png', data: Buffer.from('not-image') }),
  ).rejects.toThrow();
  const image = await store.upload(owner, scope, { name: '选择的图片.png', mimeType: 'image/png', data: png });
  expect(image).toMatchObject({ kind: 'image', mimeType: 'image/png', size: png.length });
  expect(image).not.toHaveProperty('path');
});
it('不透明资产身份仍需校验页面、会话与内容版本，运行租约禁止删除', async () => {
  const { store } = await setup();
  const owner = {};
  const uploaded = await store.upload(owner, scope, {
    name: 'notes.txt',
    mimeType: 'text/plain',
    data: Buffer.from('示例'),
  });
  const ref = { id: uploaded.id, revision: uploaded.revision };
  await expect(store.acquire({}, scope, [ref])).rejects.toThrow();
  await expect(store.acquire(owner, { ...scope, conversationId: 'other' }, [ref])).rejects.toThrow();
  await expect(store.acquire(owner, scope, [{ ...ref, revision: '0'.repeat(64) }])).rejects.toThrow();
  const lease = await store.acquire(owner, scope, [ref]);
  expect(lease.files[0]?.data.toString()).toBe('示例');
  await expect(store.remove(owner, scope, ref)).rejects.toThrow();
  await lease.bind('native-session');
  lease.release();
  await expect(store.acquire(owner, { ...scope, sessionId: 'foreign' }, [ref])).rejects.toThrow();
  const next = await store.acquire(owner, { ...scope, sessionId: 'native-session' }, [ref]);
  next.release();
});
it('只回收已证实原生自持久的预览，文件引用固定保留；总容量与单条数量有界', async () => {
  const { store, tick } = await setup(1024);
  const owner = {};
  const image = await store.upload(owner, scope, { name: 'image.png', mimeType: 'image/png', data: png });
  const file = await store.upload(owner, scope, {
    name: 'data.bin',
    mimeType: 'application/octet-stream',
    data: Buffer.from([0, 1, 255]),
  });
  const lease = await store.acquire(owner, scope, [image, file]);
  await lease.bind('native-session');
  await lease.stored([image.id]);
  lease.release();
  tick(8 * 24 * 60 * 60 * 1000);
  await store.collect();
  await expect(store.preview(owner, { ...scope, sessionId: 'native-session' }, image)).rejects.toThrow();
  expect((await store.preview(owner, { ...scope, sessionId: 'native-session' }, file)).data).toEqual(
    Buffer.from([0, 1, 255]),
  );
  await expect(
    store.upload(owner, scope, { name: 'large.txt', mimeType: 'text/plain', data: Buffer.alloc(1024, 'a') }),
  ).rejects.toThrow();
  await expect(
    store.acquire(
      owner,
      scope,
      Array.from({ length: 9 }, () => file),
    ),
  ).rejects.toThrow();
});
