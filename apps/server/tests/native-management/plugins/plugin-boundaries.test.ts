import { pluginHelp } from './plugin-help';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativePluginService } from '../../../src/native-management/plugins/plugin-service';
import type { AgentKind } from '@agentdeck/shared/conversation';
import { pluginArguments } from '../../../src/native-management/plugins/plugin-native';
import { sourceLabel } from '../../../src/native-management/plugins/plugin-utils';
const roots: string[] = [];
it('原生市场摘要保留仓库来源并剥离 URL 凭据与查询参数', () => {
  expect(sourceLabel('https://user:private-secret@example.com/repo?token=private-secret')).toBe(
    'https://example.com/repo',
  );
  expect(sourceLabel({ source: 'github', repo: 'example/fixture' })).toBe('example/fixture');
  expect(sourceLabel({ source: 'directory', path: 'fixture/local-market' })).toBe('fixture/local-market');
  expect(sourceLabel({ source: 'file', path: 'fixture/marketplace.json' })).toBe('fixture/marketplace.json');
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-plugin-boundary-'));
  roots.push(root);
  const put = async (file: string, value: unknown) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { root, put };
}
it('托管及未知插件不会因 manifest 声明配置而获得写权限，缺少原生命令不开放写入', async () => {
  const f = await fixture(),
    root = path.join(f.root, 'managed');
  await f.put(path.join(root, '.claude-plugin/plugin.json'), {
    name: 'demo',
    userConfig: { token: { type: 'string' } },
  });
  await f.put(path.join(root, '.antigravity-plugin/plugin.json'), { name: 'demo' });
  await f.put(path.join(f.root, '.claude/plugins/known_marketplaces.json'), {
    unknown: { source: { source: 'github', repo: 'example/fixture' } },
  });
  let helpAgent: AgentKind = 'claude',
    noInstall = false,
    records: unknown = [{ id: 'demo@fixture', scope: 'managed', installPath: root, hasUserConfig: true }];
  const service = createNativePluginService({
    homeDir: f.root,
    env: {},
    command: () => ({ command: process.execPath, args: [] }),
    run: (_exe, args) =>
      Promise.resolve({
        stdout: Buffer.from(pluginHelp(helpAgent, args, noInstall) ?? JSON.stringify(records)),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      }),
  });
  const claude = await service.read('claude');
  expect(claude.entries[0]!.actions).toEqual([]);
  expect(claude.marketplaces[0]!.actions).toEqual([]);
  expect(claude.entries[0]!.enabled).toBeNull();
  expect(claude.entries[0]!.version).toBeNull();
  const e = claude.entries[0]!;
  await expect(
    service.prepare('claude', { action: 'configure', id: e.id, revision: e.revision, values: { token: 'new' } }),
  ).rejects.toMatchObject({ code: 'unsupported_action' });
  helpAgent = 'antigravity';
  records = [{ name: 'external', source: 'directory', path: root, agents: ['a'], hooks: ['h'] }];
  const agy = await service.read('antigravity');
  expect(agy.entries[0]).toMatchObject({
    scope: 'external',
    actions: [],
    enabled: null,
    version: null,
    components: ['agents: a', 'hooks: h'],
  });
  records = [];
  noInstall = true;
  for (const agent of ['claude', 'antigravity'] as const) {
    helpAgent = agent;
    const c = await service.read(agent);
    expect(c.installScopes).toEqual([]);
    await expect(
      service.prepare(agent, { action: 'install', source: 'demo@fixture', revision: c.revision }),
    ).rejects.toMatchObject({ code: 'unsupported_action' });
  }
  await service.dispose();
});
it.each([
  ['codex', 'update'],
  ['antigravity', 'marketplace-add'],
  ['future-cli' as AgentKind, 'install'],
] as const)('%s 未登记的 %s 动作不生成原生命令', (agent, action) => {
  const run = () => {
    throw new Error('不应执行原生命令');
  };
  expect(() =>
    pluginArguments(
      { agent, homeDir: os.tmpdir(), env: {}, run },
      {
        action,
        revision: 'a'.repeat(64),
        source: 'demo@fixture',
      },
    ),
  ).toThrow(expect.objectContaining({ code: 'unsupported_action' }));
});
it('Codex 项目插件受不可信层约束，畸形 selector 不读取任意缓存路径', async () => {
  const f = await fixture(),
    project = { id: 'fixture', dir: path.join(f.root, 'project') },
    file = path.join(project.dir, '.codex/config.toml');
  await f.put(file, '[plugins."demo@fixture"]\nenabled=false\n[plugins."../../outside"]\nenabled=true\n');
  await f.put(path.join(f.root, '.codex/plugins/cache/fixture/demo/1/.codex-plugin/plugin.json'), {
    name: 'demo',
    version: '1',
  });
  const service = createNativePluginService({
    homeDir: f.root,
    env: {},
    command: () => ({ command: process.execPath, args: [] }),
    run: (_exe, args) =>
      Promise.resolve({ stdout: Buffer.from(pluginHelp('codex', args) ?? ''), stderr: Buffer.alloc(0), exitCode: 0 }),
    readCodexPolicy: () =>
      Promise.resolve({
        verified: true,
        enabled: {},
        layers: [{ kind: 'project', file, version: 'v1', disabled: true, plugins: {}, marketplaces: {} }],
      }),
  });
  const c = await service.read('codex', project);
  expect(c.entries).toHaveLength(2);
  expect(c.entries.every((e) => e.actions.length === 0)).toBe(true);
  expect(c.entries.find((e) => e.selector === '../../outside')!.version).toBeNull();
  await service.dispose();
});
it('项目在预览后换目录，旧 operationId 不能绕过维护锁修改旧目录', async () => {
  const f = await fixture(),
    project = { id: 'fixture', dir: f.root };
  let installs = 0;
  const service = createNativePluginService({
    homeDir: f.root,
    env: {},
    getProject: () => Promise.resolve({ ...project, dir: path.join(f.root, 'changed') }),
    command: () => ({ command: process.execPath, args: [] }),
    run: (_exe, args) => {
      if (args[1] === 'install') installs++;
      return Promise.resolve({
        stdout: Buffer.from(pluginHelp('claude', args) ?? '[]'),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      });
    },
  });
  const c = await service.read('claude', project),
    task = await service.prepare(
      'claude',
      { action: 'install', source: 'demo@fixture', revision: c.revision },
      project,
    );
  await expect(
    service.start('claude', { operationId: task.operationId, revision: task.revision }, project),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(installs).toBe(0);
  await service.dispose();
});
