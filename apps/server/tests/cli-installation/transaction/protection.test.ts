import { link, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  protectedMutation,
  replaceFromStage,
  removeOwnedTree,
} from '../../../src/cli-installation/transaction/protection';

it('安装器报告成功但新版验证失败时，程序和入口都恢复', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentdeck-restore-'));
  const program = path.join(dir, 'cli');
  const shim = path.join(dir, 'shim');
  try {
    await writeFile(program, '旧程序');
    await writeFile(shim, '旧入口');
    await expect(
      protectedMutation([program, shim], async () => {
        await writeFile(program, '损坏');
        await writeFile(shim, '新入口');
        throw new Error('接口验证失败');
      }),
    ).rejects.toThrow('接口验证失败');
    expect(await readFile(program, 'utf8')).toBe('旧程序');
    expect(await readFile(shim, 'utf8')).toBe('旧入口');
    expect((await readdir(dir)).sort()).toEqual(['cli', 'shim']);
  } finally {
    await removeOwnedTree(dir);
  }
});

it('换入暂存文件时保留旧版直至验证通过；缺少暂存入口时原状不变', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentdeck-swap-'));
  const entry = path.join(dir, 'cli');
  const staged = path.join(dir, 'new');
  const pairs = [{ target: entry, staged }];
  try {
    await writeFile(entry, '旧');
    await expect(replaceFromStage(pairs, async () => {})).rejects.toThrow();
    expect(await readFile(entry, 'utf8')).toBe('旧');
    await writeFile(staged, '新');
    await expect(
      replaceFromStage(pairs, async () => {
        throw new Error('版本错误');
      }),
    ).rejects.toThrow('版本错误');
    expect(await readFile(entry, 'utf8')).toBe('旧');
    await writeFile(staged, '新');
    await replaceFromStage(pairs, async () => {
      expect(await readFile(entry, 'utf8')).toBe('新');
    });
    expect(await readdir(dir)).toEqual(['cli']);
  } finally {
    await removeOwnedTree(dir);
  }
});

it('原生更新验证失败后还原旧版的硬链接和目录入口', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-native-links-'));
  try {
    const store = path.join(root, 'versions');
    await mkdir(store);
    const old = path.join(store, 'old');
    const cli = path.join(root, 'cli');
    const alias = path.join(root, 'current');
    await writeFile(old, '旧');
    await link(old, cli);
    await symlink(store, alias, 'junction');
    await expect(
      protectedMutation([cli, alias], async () => {
        const replacement = path.join(root, 'replacement');
        await writeFile(replacement, '新');
        await rename(replacement, cli);
        await unlink(alias);
        throw new Error('安装失败');
      }),
    ).rejects.toThrow('安装失败');
    expect((await stat(cli, { bigint: true })).ino).toBe((await stat(old, { bigint: true })).ino);
    expect(await readFile(path.join(alias, 'old'), 'utf8')).toBe('旧');
  } finally {
    await removeOwnedTree(root);
  }
});
