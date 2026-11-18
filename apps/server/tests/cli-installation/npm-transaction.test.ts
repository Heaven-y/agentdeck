import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createCliInstallationBackend } from '../../src/cli-installation';
import { createCliInstallationService } from '../../src/cli-installation/service';
import { removeOwnedTree } from '../../src/cli-installation/protection';
import { runProcess } from '../../src/platform/process/run';

// npm 安装响应可控，版本探测执行真实子进程；一切写入均位于独立 prefix。
it.runIf(process.platform === 'win32')(
  'npm 少装原生组件仍退出零：服务恢复旧版，下次更新只安装一次并清干净',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-cli-regression-'));
    const physical = path.join(root, 'node-a');
    const other = path.join(root, 'node-b');
    const prefix = path.join(root, 'global');
    await mkdir(physical);
    await symlink(physical, prefix, 'junction');
    const pkg = (dir: string) => path.join(dir, 'node_modules/@openai/codex');
    const bin = (dir: string) => path.join(pkg(dir), 'bin/codex.js');
    const put = async (file: string, contents: string) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    };
    const install = async (dir: string, version: string, broken = false) => {
      await put(
        path.join(pkg(dir), 'package.json'),
        JSON.stringify({ name: '@openai/codex', version, bin: { codex: 'bin/codex.js' } }),
      );
      await put(bin(dir), broken ? 'process.exit(1)' : `console.log('codex-cli ${version}')`);
      for (const suffix of ['', '.cmd', '.ps1'])
        await put(path.join(dir, `codex${suffix}`), '@"node" "%~dp0node_modules/@openai/codex/bin/codex.js" %*');
    };
    await put(path.join(prefix, 'npm.cmd'), '');
    await put(
      path.join(prefix, 'node_modules/npm/package.json'),
      JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }),
    );
    await put(path.join(prefix, 'node_modules/npm/bin/npm-cli.js'), '');
    await install(prefix, '1.0.0');
    let broken = true;
    let fills = 0;
    let switchPrefix = false;
    const ok = (text = '') => ({ stdout: Buffer.from(text), stderr: Buffer.alloc(0), exitCode: 0 });
    const backend = createCliInstallationBackend({
      homeDir: root,
      environment: async () => ({ PATH: prefix, USERPROFILE: root }),
      fetch: async () => Response.json({ version: '2.0.0' }),
      run: async (command, args, options) => {
        if (args.includes('prefix')) return ok(prefix);
        if (args.includes('install')) {
          const destination = args[args.indexOf('--prefix') + 1]!;
          expect(path.dirname(destination)).toBe(await realpath(physical));
          fills++;
          await install(destination, '2.0.0', broken);
          return ok();
        }
        if (command.endsWith('powershell.exe')) return ok(JSON.stringify([{ name: 'explorer.exe', image: null }]));
        return runProcess(command, args, options);
      },
    });
    const service = createCliInstallationService({
      backend,
      withIdleAgent: (_agent, run) => run(),
      onChanged: async () => {},
      verify: async () => {
        if (switchPrefix) {
          await unlink(prefix);
          await symlink(other, prefix, 'junction');
        }
        return true;
      },
    });
    const update = async () => {
      const checked = await service.check('codex');
      expect(checked.canUpdate).toBe(true);
      await service.start('codex', { action: 'update', revision: checked.revision });
      await expect.poll(async () => (await service.read('codex')).phase, { timeout: 5000 }).toMatch(/failed|succeeded/);
      return service.read('codex');
    };
    try {
      expect(await update()).toMatchObject({ phase: 'failed', currentVersion: '1.0.0' });
      expect(await readFile(bin(prefix), 'utf8')).toContain('1.0.0');
      broken = false;
      const retried = await update();
      expect(retried, retried.message ?? '').toMatchObject({ phase: 'succeeded', currentVersion: '2.0.0' });
      await unlink(bin(prefix));
      const damaged = await service.check('codex');
      expect(damaged).toMatchObject({ installed: true, currentVersion: null, canRepair: true });
      await service.start('codex', { action: 'repair', revision: damaged.revision });
      await expect.poll(async () => (await service.read('codex')).phase, { timeout: 5000 }).toBe('succeeded');
      expect((await service.read('codex')).currentVersion).toBe('2.0.0');
      await install(physical, '1.0.0');
      const customShim = path.join(physical, 'codex.ps1');
      await writeFile(customShim, 'custom command');
      expect(await update()).toMatchObject({ phase: 'failed', currentVersion: '1.0.0' });
      expect(await readFile(customShim, 'utf8')).toBe('custom command');
      expect(fills).toBe(3);
      await install(physical, '1.0.0');
      await install(other, '7.0.0');
      switchPrefix = true;
      expect(await update()).toMatchObject({ phase: 'failed' });
      expect(await readFile(bin(physical), 'utf8')).toContain('1.0.0');
      expect(await readFile(bin(other), 'utf8')).toContain('7.0.0');
      expect((await readdir(prefix)).filter((x) => x.startsWith('.agentdeck'))).toEqual([]);
    } finally {
      await service.dispose();
      await removeOwnedTree(root);
    }
  },
  20_000,
);
