import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importLegacyWorkspaces } from '../../src/workspaces/import';
import type { WorkspaceStore } from '../../src/workspaces/store';
import { createWorkspaceStore } from '../../src/workspaces/store';

let root: string;
let configDir: string;
let projectDir: string;
let store: WorkspaceStore;

const configFile = () => path.join(configDir, 'workspaces.json');
const backupFile = () => path.join(configDir, 'workspaces.json.bak');

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-import-'));
  configDir = path.join(root, 'AgentDeck');
  projectDir = path.join(root, 'project');
  await mkdir(configDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  store = createWorkspaceStore({
    configDir,
    dirExists: (p) =>
      stat(p).then(
        (s) => s.isDirectory(),
        () => false,
      ),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('importLegacyWorkspaces', () => {
  it('把旧的 localDir 迁成 dir，丢弃 sync/policy 与服务器绑定', async () => {
    await writeFile(
      configFile(),
      JSON.stringify([
        {
          id: 'w1',
          name: '旧项目',
          localDir: projectDir,
          sshHost: 'my-server',
          remoteDir: '~/projects/demo',
          sync: { mode: 'bisync' },
          policy: { allow: ['anything'] },
        },
      ]),
    );

    const report = await importLegacyWorkspaces({ configDir, store });

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(0);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'w1', name: '旧项目', dir: projectDir });
    // 只保留新 schema 声明的三个键：服务器绑定已不属于项目，旧字段一个都不能留在落盘文件里
    expect(Object.keys(list[0]!).sort()).toEqual(['dir', 'id', 'name']);
    expect(report.backupFiles).toContain(backupFile());
    await expect(readFile(backupFile(), 'utf8')).resolves.toContain('旧项目');
    await expect(readFile(backupFile(), 'utf8')).resolves.toContain('localDir');
    await expect(readFile(configFile(), 'utf8')).resolves.not.toContain('localDir');
    await expect(readFile(configFile(), 'utf8')).resolves.not.toContain('policy');
    await expect(readFile(configFile(), 'utf8')).resolves.not.toContain('sshHost');
  });

  it('目录当前不存在的旧项目照样保留，不静默丢掉用户的项目', async () => {
    await writeFile(
      configFile(),
      JSON.stringify([{ id: 'w2', name: '已删项目', localDir: path.join(root, 'gone'), sshHost: 'my-server' }]),
    );

    const report = await importLegacyWorkspaces({ configDir, store });

    // 落盘只要求绝对路径、列表本来就容忍目录离线；导入时丢掉条目会让用户的项目无声消失，
    // 比留着一条「目录不存在」的可见状态糟得多。
    expect(report).toMatchObject({ imported: 1, skipped: 0 });
    expect(await store.list()).toMatchObject([{ id: 'w2', name: '已删项目' }]);
  });

  it('没有旧文件时什么都不做', async () => {
    const report = await importLegacyWorkspaces({ configDir, store });

    expect(report).toMatchObject({ imported: 0, skipped: 0, backupFiles: [] });
    expect(await readdir(configDir)).toEqual([]);
  });

  it.each([
    ['不是合法 JSON', '{ 坏掉的 json'],
    ['不是数组', '{"workspaces":[]}'],
  ])('旧文件%s时保留原文件不迁移', async (_label, text) => {
    await writeFile(configFile(), text);

    const report = await importLegacyWorkspaces({ configDir, store });

    expect(report.imported).toBe(0);
    expect(report.message ?? '').toMatch(/无法解析/);
    await expect(readFile(configFile(), 'utf8')).resolves.toBe(text);
    expect(await readdir(configDir)).toEqual(['workspaces.json']);
  });

  it('非绝对路径的条目跳过，不中断同批的好条目；目录离线的照常保留', async () => {
    await writeFile(
      configFile(),
      JSON.stringify([
        { id: 'w3', name: '相对项目', localDir: 'relative/project' },
        { id: 'w4', name: '好项目', localDir: projectDir },
        { id: 'w5', name: '已删项目', localDir: path.join(root, 'gone') },
      ]),
    );

    const report = await importLegacyWorkspaces({ configDir, store });

    // 只有结构性错误（相对路径）被跳过；目录不存在是可恢复状态，条目必须留下。
    expect(report).toMatchObject({ imported: 2, skipped: 1 });
    expect((await store.list()).map((item) => item.id)).toEqual(['w4', 'w5']);
  });

  it('重复 id 只保留第一条，避免整份配置读不出来', async () => {
    const base = { name: '重复项目', localDir: projectDir };
    await writeFile(
      configFile(),
      JSON.stringify([
        { id: 'dup', ...base },
        { id: 'dup', ...base },
      ]),
    );

    const report = await importLegacyWorkspaces({ configDir, store });

    expect(report).toMatchObject({ imported: 1, skipped: 1 });
    expect(await store.list()).toHaveLength(1);
  });

  it('已经是新结构时原样保留，不改写也不生成备份', async () => {
    const text = `${JSON.stringify([{ id: 'w8', name: '新项目', dir: projectDir }], null, 2)}\n`;
    await writeFile(configFile(), text);

    const report = await importLegacyWorkspaces({ configDir, store });

    expect(report).toMatchObject({ imported: 0, skipped: 0, backupFiles: [] });
    await expect(readFile(configFile(), 'utf8')).resolves.toBe(text);
    await expect(readFile(backupFile(), 'utf8')).rejects.toThrow();
  });

  it('带旧绑定字段的现存配置会被转换成不含绑定的新结构', async () => {
    await writeFile(
      configFile(),
      JSON.stringify([{ id: 'w10', name: '带绑定', dir: projectDir, server: 'my-server', remoteDir: '~/demo' }]),
    );

    const report = await importLegacyWorkspaces({ configDir, store });

    expect(report.imported).toBe(1);
    expect(await store.list()).toMatchObject([{ id: 'w10', name: '带绑定', dir: projectDir }]);
    await expect(readFile(configFile(), 'utf8')).resolves.not.toContain('remoteDir');
  });

  it('已有备份时另起一个名字，不覆盖更早的原始数据', async () => {
    // 先造一份"更早的原始数据"，再让本次转换发生：旧的 .bak 必须原样还在。
    const earlier = '[{"id":"older","name":"更早的原始数据"}]';
    await writeFile(backupFile(), earlier);
    await writeFile(
      configFile(),
      JSON.stringify([{ id: 'w9', name: '旧项目', localDir: projectDir, sync: { mode: 'bisync' } }]),
    );

    const report = await importLegacyWorkspaces({ configDir, store });

    expect(report.imported).toBe(1);
    expect(report.backupFiles).toHaveLength(1);
    expect(report.backupFiles[0]).not.toBe(backupFile());
    // 旧 .bak 没被动过
    await expect(readFile(backupFile(), 'utf8')).resolves.toBe(earlier);
    // 新备份里是本次转换前的原文
    await expect(readFile(report.backupFiles[0]!, 'utf8')).resolves.toContain('w9');
  });
});
