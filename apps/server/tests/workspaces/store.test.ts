import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceStore, WorkspaceValidationError } from '../../src/workspaces/store';

let configDir: string;
let projectDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-cfg-'));
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-project-'));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

const make = (opts: { dirExists?: boolean } = {}) =>
  createWorkspaceStore({
    configDir,
    dirExists: async () => opts.dirExists ?? true,
  });

const input = () => ({ name: 'demo', dir: projectDir });

describe('createWorkspaceStore', () => {
  it('创建后返回 UUID，并持久化到磁盘', async () => {
    const ws = await make().create(input());
    expect(ws.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ws).toMatchObject({ name: 'demo', dir: path.resolve(projectDir) });
    expect(ws).not.toHaveProperty('server');
    expect(await make().list()).toEqual([ws]);
  });

  it('dir 保存为 path.resolve 后的绝对路径', async () => {
    const raw = projectDir.replace(/\\/g, '/');
    const ws = await make().create({ ...input(), dir: raw });
    expect(ws.dir).toBe(path.resolve(raw));
  });

  it('项目目录不存在时报 dir 字段错误', async () => {
    await expect(make({ dirExists: false }).create(input())).rejects.toMatchObject({
      name: 'WorkspaceValidationError',
      field: 'dir',
    });
    await expect(make({ dirExists: false }).create(input())).rejects.toThrow(/项目目录不存在/);
  });

  it('相对路径的项目目录报错', async () => {
    await expect(make().create({ ...input(), dir: 'relative/dir' })).rejects.toBeInstanceOf(WorkspaceValidationError);
  });

  it('旧配置里的服务器绑定字段被丢弃，不阻塞项目读写', async () => {
    // 服务器绑定已不属于项目：旧字段照旧通过，但不会出现在落盘结果里。
    const store = make();
    const created = await store.create({ ...input(), server: 'unknown', remoteDir: '~/projects/demo' } as never);
    expect(created).not.toHaveProperty('server');
    expect(created).not.toHaveProperty('remoteDir');
  });

  it.each(['{private-secret', '{}', '[null]', '[{"id":"secret"}]'])('%s损坏拒绝读写并保留原文', async (text) => {
    const file = path.join(configDir, 'workspaces.json');
    await writeFile(file, text, 'utf8');
    const store = make();
    for (const operation of [
      () => store.list(),
      () => store.get('secret'),
      () => store.create(input()),
      () => store.update('secret', { name: 'changed' }),
      () => store.remove('secret'),
    ]) {
      await expect(operation()).rejects.toMatchObject({ name: 'WorkspaceStorageError' });
      await expect(operation()).rejects.not.toThrow('secret');
      expect(await readFile(file, 'utf8')).toBe(text);
    }
    expect(await readdir(configDir)).toEqual(['workspaces.json']);
  });

  it('非ENOENT读取失败不能视为空配置', async () => {
    await mkdir(path.join(configDir, 'workspaces.json'));
    await expect(make().list()).rejects.toMatchObject({ name: 'WorkspaceStorageError' });
    await expect(make().create(input())).rejects.toMatchObject({ name: 'WorkspaceStorageError' });
  });

  it('混合有效与无效条目不能过滤后写回', async () => {
    const valid = await make().create(input());
    const file = path.join(configDir, 'workspaces.json');
    const text = JSON.stringify([valid, { ...valid, id: 'other', dir: '' }]);
    await writeFile(file, text, 'utf8');
    await expect(make().remove(valid.id)).rejects.toMatchObject({ name: 'WorkspaceStorageError' });
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('落盘文件里的相对目录同样阻止读取，不能带病当 cwd 用', async () => {
    const valid = await make().create(input());
    const file = path.join(configDir, 'workspaces.json');
    const text = JSON.stringify([valid, { ...valid, id: 'other', dir: 'relative/dir' }]);
    await writeFile(file, text, 'utf8');
    await expect(make().list()).rejects.toMatchObject({ name: 'WorkspaceStorageError' });
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('落盘文件里的旧服务器绑定字段不影响读取', async () => {
    // 服务器绑定已从项目 schema 移除：旧文件里的 server / remoteDir 直接忽略，
    // 让升级后的第一份配置仍能读出来，而不是逼用户手改 JSON。
    const valid = await make().create(input());
    const file = path.join(configDir, 'workspaces.json');
    const text = JSON.stringify([{ ...valid, id: 'other', server: 'my-server', remoteDir: '~/demo' }]);
    await writeFile(file, text, 'utf8');
    expect(await make().list()).toEqual([{ ...valid, id: 'other' }]);
  });

  it('update 只改指定字段，id 不变且丢弃旧服务器绑定', async () => {
    const store = make();
    const ws = await store.create(input());
    const updated = await store.update(ws.id, {
      name: '新名字',
      server: 'my-server',
      remoteDir: '~/projects/demo',
    } as never);
    expect(updated).toEqual({ id: ws.id, name: '新名字', dir: ws.dir });
    expect(await store.get(ws.id)).toEqual(updated);
  });

  it('目录暂时离线时仍能改名，不能变成只能手改文件的死条目', async () => {
    const ws = await make().create(input());
    // 移动硬盘没插：目录查不到存在，但记录还在。
    const offline = make({ dirExists: false });
    expect(await offline.list()).toEqual([ws]);
    expect(await offline.update(ws.id, { name: '改名' })).toMatchObject({ name: '改名' });
    // 但真正换到一个不存在的目录仍要被拦住。
    await expect(offline.update(ws.id, { dir: path.join(projectDir, 'missing') })).rejects.toMatchObject({
      field: 'dir',
    });
  });

  it('update / remove 不存在的 id', async () => {
    const store = make();
    expect(await store.update('nope', { name: 'x' })).toBeUndefined();
    expect(await store.remove('nope')).toBe(false);
  });

  it('remove 只删配置，不删本地文件夹', async () => {
    const store = make();
    const ws = await store.create(input());
    expect(await store.remove(ws.id)).toBe(true);
    expect(await store.get(ws.id)).toBeUndefined();
    expect(existsSync(projectDir)).toBe(true);
  });

  it('并发创建不会丢失记录', async () => {
    const store = make();
    await Promise.all([1, 2, 3, 4, 5].map((i) => store.create({ ...input(), name: `w${i}` })));
    expect((await make().list()).map((w) => w.name).sort()).toEqual(['w1', 'w2', 'w3', 'w4', 'w5']);
  });
});
