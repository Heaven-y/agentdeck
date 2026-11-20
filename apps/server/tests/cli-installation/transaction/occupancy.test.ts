import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BackendContext } from '../../../src/cli-installation/backend-support';
import { assertInstallationIdle } from '../../../src/cli-installation/transaction/occupancy';
import { runProcess, type ProcessRunner } from '../../../src/platform/process/run';

const files: string[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const file of files.splice(0).reverse()) await rm(file, { force: true });
  for (const dir of dirs.splice(0).reverse()) await rmdir(dir);
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cli occupancy '));
  dirs.push(root);
  async function dir(name: string) {
    const value = path.join(root, name);
    await mkdir(value);
    dirs.push(value);
    return value;
  }
  async function file(parent: string, name: string, content = '') {
    const value = path.join(parent, name);
    await writeFile(value, content);
    files.push(value);
    return value;
  }
  const pkg = await dir('codex');
  const copy = await dir('codex-desktop');
  const alias = path.join(root, 'linked package');
  await symlink(pkg, alias, 'junction');
  files.push(alias);
  return { pkg, alias, copy, file };
}

const signal = new AbortController().signal;
const nodeName = path.basename(process.execPath);
function context(run: ProcessRunner, platform: NodeJS.Platform = 'win32'): BackendContext {
  return { platform, run } as BackendContext;
}
function snapshot(rows: unknown) {
  return context(
    vi.fn(async () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify(rows)), stderr: Buffer.alloc(0) })),
  );
}
function node(...args: string[]) {
  return { name: nodeName, image: process.execPath, argv: [process.execPath, ...args] };
}
const unknown = { code: 'occupancy_unknown' };
const busy = { code: 'agent_busy' };

it('按实际文件或包目录定位原生映像，包括目录链接与同名前缀的独立副本', async () => {
  const f = await fixture();
  const target = await f.file(f.pkg, 'codex.exe');
  const name = path.basename(target);
  const desktop = await f.file(f.copy, name);
  const other = { name, image: desktop };
  await expect(assertInstallationIdle(snapshot([other]), [target, f.alias], signal)).resolves.toBeUndefined();
  const same = { name, image: path.join(f.alias, name) };
  for (const approved of [target, f.pkg]) {
    await expect(assertInstallationIdle(snapshot([other, same]), [approved], signal)).rejects.toMatchObject(busy);
  }
});

it('只取 Node 主入口，跳过选项值、普通参数与内联脚本', async () => {
  const f = await fixture();
  const entry = await f.file(f.pkg, 'cli.js');
  const other = await f.file(f.copy, 'cli.js');
  const idle = [
    node('--require', entry, other, entry),
    node('-e', '0', entry),
    node('--import', 'tsx', '--input-type=module', '-'),
    { name: 'System', image: null },
  ];
  await expect(assertInstallationIdle(snapshot(idle), [f.pkg], signal)).resolves.toBeUndefined();
  const rows = [...idle, node('--no-warnings', '--', path.join(f.alias, 'cli.js'))];
  await expect(assertInstallationIdle(snapshot(rows), [entry], signal)).rejects.toMatchObject(busy);
});

it('候选证据不完整、枚举无结果或失败时不放行，已确认占用优先', async () => {
  const f = await fixture();
  const entry = await f.file(f.pkg, 'cli.js');
  const native = await f.file(f.pkg, 'codex.exe');
  const hidden = { name: path.basename(native), image: null };
  for (const rows of [[], [{}], [hidden], [node('cli.js')], [{ ...node(), argv: null }]]) {
    await expect(assertInstallationIdle(snapshot(rows), [f.pkg], signal)).rejects.toMatchObject(unknown);
  }
  await expect(assertInstallationIdle(snapshot([hidden, node(entry)]), [f.pkg], signal)).rejects.toMatchObject(busy);
  const run = vi.fn<ProcessRunner>().mockRejectedValue(new Error('private-argv'));
  await expect(assertInstallationIdle(context(run), [entry], signal)).rejects.toMatchObject({
    ...unknown,
    message: expect.not.stringContaining('private-argv'),
  });
  run.mockClear();
  await expect(assertInstallationIdle(context(run), [entry], AbortSignal.abort())).rejects.toMatchObject({
    code: 'aborted',
  });
  await expect(
    assertInstallationIdle(context(run), [path.join(f.pkg, 'missing.ps1'), path.join(f.pkg, 'new', 'bin')], signal),
  ).resolves.toBeUndefined();
  await expect(
    assertInstallationIdle(snapshot([node(entry)]), [path.join(f.pkg, 'missing.ps1'), entry], signal),
  ).rejects.toMatchObject(busy);
  expect(run).not.toHaveBeenCalled();
});

it.runIf(['win32', 'linux', 'darwin'].includes(process.platform))(
  '真实进程表识别带空格的 npm 入口，检测后进程仍可响应',
  async () => {
    const f = await fixture();
    const entry = await f.file(
      f.pkg,
      'cli.js',
      "process.stdin.on('data', () => process.stdout.write('alive')); process.stdout.write('ready');",
    );
    await f.file(f.pkg, 'package.json', JSON.stringify({ name: 'occupancy-fixture', bin: './cli.js' }));
    // 共享机器可有改写进程标题或不可读参数的 Node；空闲判断由受控快照覆盖。
    // 此处只验证真实系统能定位我们的子进程，且探测不会终止它。
    const child = spawn(process.execPath, [path.join(f.alias, 'cli.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
    const closed = once(child, 'close');
    try {
      await once(child.stdout, 'data');
      await expect(
        assertInstallationIdle(context(runProcess, process.platform), [entry], signal),
      ).rejects.toMatchObject(busy);
      const reply = once(child.stdout, 'data');
      child.stdin.write('ping');
      expect(String((await reply)[0])).toBe('alive');
    } finally {
      child.stdin.end();
      await closed;
    }
  },
  60_000,
);
