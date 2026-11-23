import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkbenchPluginManifest } from '@agentdeck/shared/plugins';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkbenchPlugins } from '../../src/plugins/service';

const roots: string[] = [];
const manifest: WorkbenchPluginManifest = {
  id: 'demo-plugin',
  name: '示例插件',
  version: '1.0.0',
  apiVersion: 1,
  entry: 'index.html',
  permissions: ['storage', 'project-context'],
  commands: [{ id: 'open-demo', title: '打开示例' }],
};
const html = '<!doctype html><html lang="zh"><body><script>document.body.dataset.ready="yes"</script></body></html>';
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-plugins-'));
  roots.push(root);
  const directory = path.join(root, 'package');
  const configDir = path.join(root, 'config');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'agentdeck.plugin.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, 'index.html'), html);
  return {
    root,
    directory,
    configDir,
    service: createWorkbenchPlugins({ configDir }),
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('工作台插件宿主', () => {
  it('全新安装为空，外部插件安装后保持停用，修改源目录不改变已安装副本', async () => {
    const { service, directory, configDir } = await fixture();
    expect((await service.list()).plugins).toEqual([]);
    const installed = await service.install({ directory });
    expect(installed.plugins).toMatchObject([{ enabled: false }]);
    expect(await createWorkbenchPlugins({ configDir }).list()).toEqual(installed);
    await fs.writeFile(path.join(directory, 'index.html'), 'changed');
    await service.update('demo-plugin', { enabled: true, revision: installed.revision });
    expect(await service.page('demo-plugin')).toEqual({ html });
    await service.dispose();
  });
  it('存储隔离在已启用且有权限的插件，修订冲突不覆盖；卸载仅删除自有文件', async () => {
    const { service, directory } = await fixture();
    const installed = await service.install({ directory });
    await expect(service.readStorage('demo-plugin')).rejects.toMatchObject({ code: 'plugin_disabled' });
    const enabled = await service.update('demo-plugin', { enabled: true, revision: installed.revision });
    expect(await service.readStorage('demo-plugin')).toEqual({ value: {}, revision: 'missing' });
    const saved = await service.saveStorage('demo-plugin', { value: { count: 3 }, revision: 'missing' });
    expect(await service.readStorage('demo-plugin')).toEqual(saved);
    await expect(
      service.saveStorage('demo-plugin', { value: { count: 4 }, revision: 'missing' }),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(
      service.saveStorage('demo-plugin', { value: { text: 'a'.repeat(65536) }, revision: saved.revision }),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(service.readStorage('missing-plugin')).rejects.toMatchObject({ code: 'plugin_missing' });
    const removed = await service.remove('demo-plugin', { revision: enabled.revision });
    expect(removed.plugins).toHaveLength(0);
    expect(await fs.readFile(path.join(directory, 'index.html'), 'utf8')).toBe(html);
    await expect(service.page('demo-plugin')).rejects.toMatchObject({ code: 'plugin_missing' });
  });

  it('拒绝重复安装、旧修订及安装包中的路径穿越、代码执行入口与凭据文件', async () => {
    const { service, directory } = await fixture();
    const installed = await service.install({ directory });
    await expect(service.install({ directory })).rejects.toMatchObject({ code: 'already_installed' });
    for (const unsupported of ['relative/plugin', `\\\\${path.basename(directory)}\\package`])
      await expect(service.install({ directory: unsupported })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.update('demo-plugin', { enabled: true, revision: 'missing' })).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    expect((await service.list()).revision).toBe(installed.revision);
    for (const patch of [
      { entry: '../outside.html' },
      { entry: 'nested\\entry.html' },
      { apiVersion: 999 },
      { permissions: ['shell'] },
    ]) {
      const other = await fixture();
      await fs.writeFile(
        path.join(other.directory, 'agentdeck.plugin.json'),
        JSON.stringify({ ...manifest, ...patch }),
      );
      await expect(other.service.install({ directory: other.directory })).rejects.toMatchObject({
        code: 'invalid_manifest',
      });
      expect((await other.service.list()).plugins).toHaveLength(0);
    }
    for (const name of ['.env', 'private.key', 'package.json', 'credentials.json', 'server.ts']) {
      const other = await fixture();
      await fs.writeFile(path.join(other.directory, name), 'private-sentinel');
      const failure: unknown = await other.service
        .install({ directory: other.directory })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'package_rejected' });
      expect(String(failure)).not.toContain('private-sentinel');
    }
  });

  it('拒绝目录/文件链接和超量包，已安装入口被替换也不能越界读取', async () => {
    const { root, directory, service, configDir } = await fixture();
    const outside = path.join(root, 'outside.html');
    await fs.writeFile(outside, 'private-sentinel');
    await fs.symlink(outside, path.join(directory, 'linked.html'), 'file');
    await expect(service.install({ directory })).rejects.toMatchObject({ code: 'unsafe_path' });
    await fs.unlink(path.join(directory, 'linked.html'));
    const installed = await service.install({ directory });
    const enabled = await service.update('demo-plugin', { enabled: true, revision: installed.revision });
    const copied = path.join(configDir, 'workbench-plugins', 'packages', 'demo-plugin', 'index.html');
    await fs.unlink(copied);
    await fs.symlink(outside, copied, 'file');
    await expect(service.page('demo-plugin')).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(service.remove('demo-plugin', { revision: enabled.revision })).rejects.toMatchObject({
      code: 'unsafe_path',
    });
    expect(await fs.readFile(outside, 'utf8')).toBe('private-sentinel');
    const oversized = await fixture();
    await fs.writeFile(path.join(oversized.directory, 'large.js'), Buffer.alloc(10 * 1024 * 1024));
    await expect(oversized.service.install({ directory: oversized.directory })).rejects.toMatchObject({
      code: 'too_large',
    });
    const excessive = await fixture();
    for (let index = 0; index < 255; index++)
      await fs.writeFile(path.join(excessive.directory, `asset-${index}.css`), '');
    await expect(excessive.service.install({ directory: excessive.directory })).rejects.toMatchObject({
      code: 'too_large',
    });
  });
});

it('读取旧登记表时只保留已安装记录，下次写入清理退出的内置字段', async () => {
  const { configDir, directory, service } = await fixture();
  const folder = path.join(configDir, 'workbench-plugins');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, 'registry.json');
  await fs.writeFile(file, JSON.stringify({ version: 2, builtinEnabled: { retired: true }, plugins: [] }));
  expect((await service.list()).plugins).toEqual([]);
  await service.install({ directory });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(saved.version).toBe(3);
  expect(saved).not.toHaveProperty('builtinEnabled');
});
