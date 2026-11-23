import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkbenchPluginManifestSchema, WorkbenchPluginHostRequestSchema } from '@agentdeck/shared/plugins';
import { createPluginHostServices } from '../../src/bootstrap/plugin-services';
import { createWorkbenchPlugins } from '../../src/plugins/service';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function removeTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeTree(target);
    else await unlink(target);
  }
  await rmdir(directory);
}
const manifest = {
  id: 'fixture',
  name: '扩展夹具',
  version: '1.0.0',
  apiVersion: 2,
  entry: 'index.html',
  permissions: ['projects', 'session-history'],
};
it('纯界面 v2 无后端也能安装，通过授权服务读取项目，停用后拒绝调用', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-host-'));
  cleanups.push(() => removeTree(root));
  const directory = path.join(root, 'source');
  await mkdir(directory);
  await writeFile(path.join(directory, 'agentdeck.plugin.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'index.html'), '<h1>夹具</h1>');
  await writeFile(path.join(directory, 'README.md'), '# 使用说明');
  const host = vi.fn().mockResolvedValue([{ id: 'project', name: '示例', dir: 'fixtures' }]);
  const service = createWorkbenchPlugins({ configDir: path.join(root, 'config'), host });
  cleanups.push(() => service.dispose());
  const installed = await service.install({ directory });
  const enabled = await service.update('fixture', { enabled: true, revision: installed.revision });
  expect(await service.host('fixture', { method: 'projects.list' })).toEqual([
    { id: 'project', name: '示例', dir: 'fixtures' },
  ]);
  await expect(service.backend('fixture', { method: 'GET', url: '/' })).rejects.toMatchObject({
    code: 'permission_denied',
  });
  await service.update('fixture', { enabled: false, revision: enabled.revision });
  await expect(service.host('fixture', { method: 'projects.list' })).rejects.toMatchObject({ code: 'plugin_disabled' });
  expect(host).toHaveBeenCalledOnce();
  await service.dispose();
  await expect(service.host('fixture', { method: 'projects.list' })).rejects.toMatchObject({ code: 'plugin_disabled' });
});
it('原生会话始终带项目归属，读取最近一页后用原生游标继续加载，并转交取消信号', async () => {
  const workspace = { id: 'project', name: '示例', dir: 'fixtures' };
  const get = vi.fn(async (id: string) => (id === workspace.id ? workspace : undefined));
  const page = vi.fn().mockResolvedValue({ items: [], nextCursor: 'next' });
  const readHistoryPage = vi.fn().mockResolvedValue({ events: [], page: { before: 'before' } });
  const host = createPluginHostServices({ get, list: async () => [workspace] }, { page, readHistoryPage });
  const signal = new AbortController().signal;
  await host({ method: 'sessions.list', params: { projectId: 'project', agent: 'codex', cursor: 'next' } }, signal);
  expect(page).toHaveBeenCalledExactlyOnceWith(
    { projectId: 'project', agent: 'codex', cursor: 'next', scope: 'active' },
    signal,
  );
  await host(
    {
      method: 'sessions.history',
      params: { projectId: 'project', agent: 'codex', sessionId: 'session', before: 'before' },
    },
    signal,
  );
  expect(readHistoryPage).toHaveBeenCalledExactlyOnceWith(
    workspace,
    { projectId: 'project', agent: 'codex', sessionId: 'session', before: 'before' },
    'before',
    signal,
  );
  await expect(
    host({ method: 'sessions.history', params: { projectId: 'missing', agent: 'codex', sessionId: 'session' } }),
  ).rejects.toMatchObject({ code: 'workspace_missing' });
  expect(readHistoryPage).toHaveBeenCalledOnce();
});
it('拒绝无效贡献引用、重复入口、未授权事件和把权限与后端文件分开声明', () => {
  for (const patch of [
    {
      contributes: {
        pages: [
          { id: 'main', title: '主页', location: 'sidebar' },
          { id: 'main', title: '重复', location: 'settings' },
        ],
      },
    },
    { contributes: { pages: [], actions: [{ command: 'missing', location: 'composer' }] } },
    { events: ['turn.completed'] },
    { backend: 'backend.cjs' },
    { permissions: ['backend'] },
    { commands: [{ id: 'wrong', title: '不存在的页面', page: 'missing' }] },
  ])
    expect(WorkbenchPluginManifestSchema.safeParse({ ...manifest, ...patch }).success).toBe(false);
});
it('插件历史接口复用原生会话身份校验，拒绝路径和无效分页游标', () => {
  const input = { method: 'sessions.history', params: { projectId: 'project', agent: 'codex', sessionId: 'valid-id' } };
  for (const patch of [{ sessionId: '../outside' }, { sessionId: 'dir\\outside' }, { before: '../outside' }])
    expect(
      WorkbenchPluginHostRequestSchema.safeParse({ ...input, params: { ...input.params, ...patch } }).success,
    ).toBe(false);
});
