import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeProtectionPaths, cleanupNativeHistory } from '../../src/cli-installation/native-installation';
import { executeInstallation } from '../../src/cli-installation/installer';
import { createCliInstallationBackend } from '../../src/cli-installation';
import { inspectInstallation } from '../../src/cli-installation/discovery';
import type { BackendContext } from '../../src/cli-installation/backend-support';
import type { CliInstallation } from '../../src/cli-installation/types';
import { resolveLocalCommand } from '../../src/platform/process/executable';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const binary = 'AGY_CLI_DISABLE_AUTO_UPDATE antigravity-cli-auto-updater-974169037036.us-central1.run.app';
async function fixture(agent: CliInstallation['agent']) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'agentdeck-native-'));
  roots.push(root);
  const homeDir = path.join(root, 'home'),
    local = path.join(root, 'local');
  const env = { USERPROFILE: homeDir, LOCALAPPDATA: local, SystemRoot: path.join(root, 'system'), PATH: '' };
  const entry =
    agent === 'claude'
      ? path.join(homeDir, '.local/bin/claude.exe')
      : agent === 'codex'
        ? path.join(local, 'Programs/OpenAI/Codex/bin/codex.exe')
        : path.join(local, 'agy/bin/agy.exe');
  const installation: CliInstallation = {
    agent,
    command: { command: entry, args: [] },
    version: '1.0.0',
    identity: 'fixture',
    installed: true,
    source: 'native',
    canUpdate: true,
    canInstall: false,
    message: null,
    guideUrl: '',
  };
  const put = async (file: string, data = '') => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  };
  const occupied: string[] = [];
  const context: BackendContext = {
    platform: 'win32',
    arch: 'x64',
    homeDir,
    environment: async () => env,
    resolveCommand: resolveLocalCommand,
    run: async (_cmd, args, opt) => {
      const file = opt.env?.AGENTDECK_SIGNATURE_FILE;
      const text = file
        ? agent === 'claude'
          ? 'Anthropic, PBC'
          : 'Google LLC'
        : args.includes('--version')
          ? 'unreadable'
          : JSON.stringify([
              { image: null, name: 'explorer.exe' },
              ...occupied.map((image) => ({ image, name: path.basename(image) })),
            ]);
      return { stdout: Buffer.from(text), stderr: Buffer.alloc(0), exitCode: 0 };
    },
    operationRun: vi.fn(),
    fetch: vi.fn(async (url) =>
      typeof url === 'string' && url.endsWith('manifest.json')
        ? Response.json({
            version: '2.0.0',
            platforms: { 'win32-x64': { checksum: createHash('sha256').update('new').digest('hex') } },
          })
        : new Response('new'),
    ),
  };
  return { context, installation, root, homeDir, entry, put, occupied };
}
it.each(['硬链接', '符号链接', '占用', '同名替换'])('Claude 按原身份清理本次切走的版本：%s', async (mode) => {
  const busy = mode === '占用';
  const f = await fixture('claude');
  const versions = path.join(f.homeDir, '.local/share/claude/versions');
  const old = path.join(versions, '1.0.0.exe');
  const unrelated = path.join(versions, '0.9.0.exe');
  await f.put(old, 'old');
  await f.put(unrelated, 'other');
  await mkdir(path.dirname(f.entry), { recursive: true });
  if (mode === '符号链接') await symlink(old, f.entry, 'file');
  else await link(old, f.entry);
  const current = await inspectInstallation(f.context, 'claude');
  expect(current).toMatchObject({
    source: 'native',
    version: null,
    canRepair: true,
    message: expect.stringMatching(/版本.*修复/),
  });
  expect(await nativeProtectionPaths(f.context, current, '2.0.0')).toEqual([f.entry, path.join(versions, '2.0.0.exe')]);
  await executeInstallation(f.context, current, '2.0.0', new AbortController().signal);
  if (busy) f.occupied.push(await realpath(old));
  if (mode === '同名替换') {
    await unlink(old);
    await f.put(old, 'other');
  }
  const cleanup = cleanupNativeHistory(f.context, current);
  if (busy) {
    await expect(cleanup).rejects.toThrow();
    expect(await readFile(old, 'utf8')).toBe('old');
  } else if (mode === '同名替换') {
    await cleanup;
    expect(await readFile(old, 'utf8')).toBe('other');
  } else {
    await cleanup;
    await expect(lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await readFile(unrelated, 'utf8')).toBe('other');
  expect(await readFile(f.entry, 'utf8')).toBe('new');
});
it.each(['正常', '旧件夹带', '目标夹带链接', '新增文件', '目标指回旧版'])(
  'Codex 只清理本次切走且身份完整的 release：%s',
  async (mode) => {
    const f = await fixture('codex'),
      root = path.join(f.homeDir, '.codex/packages/standalone'),
      releases = path.join(root, 'releases');
    const suffix = '-x86_64-pc-windows-msvc',
      old = path.join(releases, '1.0.0' + suffix),
      next = path.join(releases, '2.0.0' + suffix);
    const current = path.join(root, 'current');
    for (const dir of [old, next]) await f.put(path.join(dir, 'bin/codex.exe'), 'program');
    if (mode === '旧件夹带') await f.put(path.join(old, 'user.txt'), 'user');
    await symlink(old, current, 'junction');
    await mkdir(path.dirname(path.dirname(f.entry)), { recursive: true });
    await symlink(path.join(current, 'bin'), path.dirname(f.entry), 'junction');
    const installed = await inspectInstallation(f.context, 'codex');
    expect(installed).toMatchObject({ source: 'native', version: null, canRepair: true });
    if (mode === '目标夹带链接') {
      const external = path.join(f.root, 'other');
      await f.put(path.join(external, 'rg.exe'), 'user');
      await symlink(external, path.join(next, 'codex-resources'), 'junction');
      await expect(nativeProtectionPaths(f.context, installed, '2.0.0')).rejects.toThrow();
      expect(await readFile(path.join(external, 'rg.exe'), 'utf8')).toBe('user');
      return;
    }
    expect(await nativeProtectionPaths(f.context, installed, '2.0.0')).toEqual(
      expect.arrayContaining([path.dirname(f.entry), current, next, path.join(root, 'auto-update-version')]),
    );
    if (mode === '目标指回旧版') {
      await unlink(path.join(next, 'bin/codex.exe'));
      await rmdir(path.join(next, 'bin'));
      await rmdir(next);
      await symlink(old, next, 'junction');
    }
    if (mode === '新增文件') await f.put(path.join(old, 'user.txt'), 'user');
    await unlink(current);
    await symlink(next, current, 'junction');
    await cleanupNativeHistory(f.context, installed);
    if (mode === '目标指回旧版') expect(await readFile(path.join(old, 'bin/codex.exe'), 'utf8')).toBe('program');
    else if (mode === '旧件夹带' || mode === '新增文件')
      expect(await readFile(path.join(old, 'user.txt'), 'utf8')).toBe('user');
    else await expect(lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(f.entry, 'utf8')).toBe('program');
  },
);
it('agy 只清理签名、产品、目录、命名和占用均能核实的旧件', async () => {
  const f = await fixture('antigravity');
  await f.put(f.entry, binary);
  const old = f.entry + '.1794993259609535800.old',
    other = f.entry + '.1794993259609535801.old';
  await f.put(old, binary);
  await f.put(other, '其他 Google 程序');
  await f.put(f.entry + '.old', binary);
  expect(await inspectInstallation(f.context, 'antigravity')).toMatchObject({
    source: 'native',
    version: null,
    canRepair: true,
  });
  await cleanupNativeHistory(f.context, f.installation);
  await expect(lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(other, 'utf8')).toBe('其他 Google 程序');
  expect(await readFile(f.entry + '.old', 'utf8')).toBe(binary);
});

it.each(['claude', 'antigravity'] as const)('下载期间 %s 被启动时保留原入口', async (agent) => {
  const f = await fixture(agent);
  await f.put(f.entry, binary);
  const url =
    'https://storage.googleapis.com/antigravity-public/antigravity-cli/2.0.0-build/windows-x64/cli_windows_x64.exe';
  const fetcher = f.context.fetch;
  f.context.fetch = async (input, init) => {
    if (typeof input === 'string' && input.endsWith('.exe')) {
      f.occupied.push(await realpath(f.entry));
      return new Response('new');
    }
    if (agent === 'claude') return fetcher(input, init);
    return Response.json({ url, version: '2.0.0', sha512: createHash('sha512').update('new').digest('hex') });
  };
  await expect(
    executeInstallation(f.context, f.installation, '2.0.0', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'agent_busy' });
  expect(await readFile(f.entry, 'utf8')).toBe(binary);
});

it.each([false, true])('正式事务在最终接口验证后才清理 Claude 旧硬链接，验证通过 %s', async (compatible) => {
  const f = await fixture('claude');
  const versions = path.join(f.homeDir, '.local/share/claude/versions');
  const old = path.join(versions, '1.0.0.exe');
  await f.put(old, 'old');
  await mkdir(path.dirname(f.entry), { recursive: true });
  await link(old, f.entry);
  const backend = createCliInstallationBackend(f.context);
  const installation = await backend.inspect('claude');
  expect(installation.canRepair).toBe(true);
  const task = backend.transact(installation, '2.0.0', new AbortController().signal, async () => {
    expect(await readFile(old, 'utf8')).toBe('old');
    expect(await readFile(f.entry, 'utf8')).toBe('new');
    if (!compatible) throw new Error('工作台接口不兼容');
  });
  if (compatible) {
    await task;
    await expect(lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    await expect(task).rejects.toThrow('工作台接口不兼容');
    expect(await readFile(f.entry, 'utf8')).toBe('old');
    expect((await stat(f.entry, { bigint: true })).ino).toBe((await stat(old, { bigint: true })).ino);
  }
});
