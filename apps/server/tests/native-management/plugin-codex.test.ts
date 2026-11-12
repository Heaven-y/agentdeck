import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativePluginService } from '../../src/native-management/plugin-service';
import { mcpPluginsFromRecords } from '../../src/native-management/mcp-plugins';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-codex-plugins-'));
  roots.push(root);
  const base = path.join(root, '.codex');
  const plugin = path.join(base, 'plugins/cache/fixture/demo/1.0.0');
  await mkdir(path.join(plugin, '.codex-plugin'), { recursive: true });
  await writeFile(path.join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  const file = path.join(base, 'config.toml');
  await writeFile(file, '# retained\n[plugins."demo@fixture"]\nenabled = true\nextra = "keep"\n');
  const commands: string[][] = [];
  const policy = {
    verified: true,
    enabled: { 'demo@fixture': { enabled: true } },
    layers: [
      {
        kind: 'user',
        file,
        version: 'user-v1',
        disabled: false,
        plugins: { 'demo@fixture': { enabled: true } },
        marketplaces: {},
      },
    ],
  };
  const service = createNativePluginService({
    homeDir: root,
    env: {},
    command: () => ({ command: process.execPath, args: [] }),
    run: async (_exe, args) => {
      commands.push(args);
      return { stdout: Buffer.from('0.166.0'), stderr: Buffer.alloc(0), exitCode: 0 };
    },
    readCodexPolicy: async () => policy,
  });
  return { root, base, plugin, file, service, commands, policy };
}
it('Codex 离线列表不用 plugin RPC 或联网 list，定点启停保留未知字段', async () => {
  const f = await fixture();
  const catalog = await f.service.read('codex');
  const entry = catalog.entries[0]!;
  expect(entry.version).toBe('1.0.0');
  expect(entry.actions).not.toContain('update');
  const task = await f.service.prepare('codex', { action: 'disable', id: entry.id, revision: entry.revision });
  await f.service.start('codex', { operationId: task.operationId, revision: task.revision });
  for (let n = 0; n < 100 && f.service.operation('codex', undefined, task.operationId).status === 'running'; n++)
    await new Promise((r) => setTimeout(r, 5));
  const text = await readFile(f.file, 'utf8');
  expect(text).toContain('enabled = false');
  expect(text).toContain('extra = "keep"');
  expect(text).toContain('# retained');
  expect(f.commands.every((args) => args[0] === '--version')).toBe(true);
});
it('Codex 托管来源禁止启停，未核实策略不得开放写入', async () => {
  const f = await fixture();
  f.policy.layers.push({
    kind: 'enterpriseManaged',
    file: '',
    version: 'managed-v1',
    disabled: false,
    plugins: { 'demo@fixture': { enabled: true } },
    marketplaces: {},
  });
  const catalog = await f.service.read('codex');
  expect(catalog.entries.every((e) => e.actions.length === 0)).toBe(true);
  f.policy.layers.pop();
  f.policy.verified = false;
  expect((await f.service.read('codex')).entries[0]!.actions).toEqual([]);
});
it('Codex 插件 MCP 读取原生 .mcp.json 并保留插件身份', async () => {
  const f = await fixture();
  await writeFile(path.join(f.plugin, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'node' } } }));
  const records = await mcpPluginsFromRecords({ agent: 'codex', homeDir: f.root, env: {} }, [
    { id: 'demo@fixture', scope: 'user', installPath: f.plugin },
  ]);
  expect(records).toMatchObject([
    { owner: 'demo@fixture', name: 'demo', scope: 'user', installationRoot: f.plugin, config: { command: 'node' } },
  ]);
});
it('Codex 本地市场不提供 Git 刷新，来源移除仍绑定准确名称', async () => {
  const f = await fixture();
  await writeFile(f.file, `[marketplaces.fixture]\nsource_type="local"\nsource=${JSON.stringify(f.plugin)}\n`);
  const c = await f.service.read('codex');
  expect(c.marketplaces[0]!.actions).toEqual(['marketplace-remove']);
});
it('Codex 显式 Git 市场刷新和后续原生 list 都限定同一来源', async () => {
  const f = await fixture();
  await writeFile(f.file, '[marketplaces.fixture]\nsource_type="git"\nsource="https://example.com/fixture.git"\n');
  const calls: string[][] = [];
  const service = createNativePluginService({
    homeDir: f.root,
    env: {},
    command: () => ({ command: process.execPath, args: [] }),
    readCodexPolicy: () => Promise.resolve(f.policy),
    run: (_exe, args) => {
      calls.push(args);
      return Promise.resolve({
        stdout: Buffer.from(args[0] === '--version' ? '0.166.0' : args[1] === 'list' ? '{"installed":[]}' : '{}'),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      });
    },
  });
  const m = (await service.read('codex')).marketplaces[0]!,
    task = await service.prepare('codex', { action: 'marketplace-refresh', id: m.id, revision: m.revision });
  await service.start('codex', { operationId: task.operationId, revision: task.revision });
  for (let n = 0; n < 100 && service.operation('codex', undefined, task.operationId).status === 'running'; n++)
    await new Promise((r) => setTimeout(r, 5));
  expect(service.operation('codex', undefined, task.operationId).status).toBe('succeeded');
  expect(calls).toContainEqual(['plugin', 'marketplace', 'upgrade', 'fixture', '--json']);
  expect(calls).toContainEqual(['plugin', 'list', '--marketplace', 'fixture', '--json']);
  await service.dispose();
});
