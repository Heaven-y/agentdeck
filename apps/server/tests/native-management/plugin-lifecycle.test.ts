import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativePluginService } from '../../src/native-management/plugin-service';
import { createNativeManagementAccess } from '../../src/native-management/access';
import { createCliActivity } from '../../src/bootstrap/cli-activity';
import { createWorkspaceActivity } from '../../src/workspaces/activity';
import { codexPluginPolicy } from '../../src/native-management/plugin-policy';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-plugin-life-'));
  roots.push(root);
  const put = async (file: string, value: unknown) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { root, put };
}
async function end(
  service: ReturnType<typeof createNativePluginService>,
  agent: 'claude' | 'codex' | 'antigravity',
  task: { operationId: string; revision: string },
  project?: { id: string; dir: string },
) {
  await service.start(agent, { operationId: task.operationId, revision: task.revision }, project);
  for (let n = 0; n < 100; n++) {
    const result = service.operation(agent, project, task.operationId);
    if (!['running', 'cancelling'].includes(result.status)) return result;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('任务未结束');
}
it('AGY 本地安装、启停、验证、卸载按真实列表核实，不提供项目或更新操作', async () => {
  const f = await fixture(),
    root = path.join(f.root, '.gemini/config/plugins/demo'),
    source = path.join(f.root, 'source');
  await f.put(path.join(source, 'plugin.json'), { name: 'demo' });
  await f.put(path.join(root, 'plugin.json'), { name: 'demo', description: 'Fixture' });
  let installed = false,
    enabled = false;
  const calls: string[][] = [];
  const service = createNativePluginService({
    homeDir: f.root,
    env: {},
    command: () => ({ command: process.execPath, args: [] }),
    run: async (_exe, args) => {
      calls.push(args);
      let value: unknown = {};
      if (args[0] === '--version') value = '1.5.3';
      else if (args[1] === 'list')
        value = installed
          ? [{ name: 'demo', source: 'antigravity', path: root, version: '1.0.0', enabled, skills: ['demo'] }]
          : [];
      else if (args[1] === 'install') installed = true;
      else if (args[1] === 'enable') enabled = true;
      else if (args[1] === 'disable') enabled = false;
      else if (args[1] === 'uninstall') installed = false;
      return {
        stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    },
  });
  let catalog = await service.read('antigravity');
  const task = await service.prepare('antigravity', { action: 'install', source, revision: catalog.revision });
  expect((await end(service, 'antigravity', task)).status).toBe('succeeded');
  catalog = await service.read('antigravity');
  expect(catalog.entries[0]!.enabled).toBe(false);
  expect(catalog.entries[0]!.actions).not.toContain('update');
  expect(catalog.installScopes).toEqual(['user']);
  for (const action of ['enable', 'disable', 'validate', 'uninstall'] as const) {
    const entry = (await service.read('antigravity')).entries[0]!;
    expect(
      (
        await end(
          service,
          'antigravity',
          await service.prepare('antigravity', { action, id: entry.id, revision: entry.revision }),
        )
      ).status,
    ).toBe('succeeded');
  }
  expect(calls).toContainEqual(['plugin', 'validate', root, '--json']);
  expect(calls.flat()).not.toContain('--scope');
  await service.dispose();
});
it('Claude 市场增删刷新只选指定来源和作用域，卸载始终保留数据', async () => {
  const f = await fixture(),
    project = { id: 'demo', dir: path.join(f.root, 'project') },
    market = path.join(f.root, 'market');
  await mkdir(project.dir);
  await mkdir(market);
  const settings = path.join(project.dir, '.claude/settings.json'),
    known = path.join(f.root, '.claude/plugins/known_marketplaces.json');
  let installed = true;
  const calls: string[][] = [];
  const service = createNativePluginService({
    homeDir: f.root,
    env: {},
    command: () => ({ command: process.execPath, args: [] }),
    run: async (_exe, args) => {
      calls.push(args);
      let value: unknown = {};
      if (args[0] === '--version') value = '2.1.317';
      else if (args[1] === 'list')
        value = installed
          ? [
              {
                id: 'demo@fixture',
                scope: 'user',
                version: '1',
                enabled: true,
                installPath: path.join(f.root, 'plugin'),
              },
            ]
          : [];
      else if (args[1] === 'uninstall') installed = false;
      else if (args[2] === 'add') {
        await f.put(settings, {
          extraKnownMarketplaces: { fixture: { source: { source: 'directory', path: market } } },
        });
        await f.put(known, { fixture: { source: { source: 'directory', path: market }, installLocation: market } });
      } else if (args[2] === 'remove') {
        await f.put(settings, {});
        await f.put(known, {});
      }
      return {
        stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    },
  });
  const before = await service.read('claude', project);
  await end(
    service,
    'claude',
    await service.prepare(
      'claude',
      { action: 'marketplace-add', source: market, scope: 'project', revision: before.revision },
      project,
    ),
    project,
  );
  for (const action of ['marketplace-refresh', 'marketplace-remove'] as const) {
    const m = (await service.read('claude', project)).marketplaces[0]!;
    expect(
      (
        await end(
          service,
          'claude',
          await service.prepare('claude', { action, id: m.id, revision: m.revision }, project),
          project,
        )
      ).status,
    ).toBe('succeeded');
  }
  const entry = (await service.read('claude', project)).entries[0]!;
  await end(
    service,
    'claude',
    await service.prepare('claude', { action: 'uninstall', id: entry.id, revision: entry.revision }, project),
    project,
  );
  expect(calls).toContainEqual(['plugin', 'marketplace', 'update', 'fixture', '--json']);
  expect(calls).toContainEqual(['plugin', 'marketplace', 'remove', 'fixture', '--scope', 'project', '--json']);
  expect(calls).toContainEqual(['plugin', 'uninstall', 'demo@fixture', '--scope', 'user', '--keep-data', '--json']);
  await service.dispose();
});
it('等待原生命令确认期间持有维护与项目租约，取消退出后释放', async () => {
  const f = await fixture(),
    project = { id: 'demo', dir: f.root },
    native = createCliActivity(),
    workspace = createWorkspaceActivity();
  let idleLease = false,
    changedUnderLease = false;
  const access = createNativeManagementAccess({
    withIdleAgent: async (_agent, operation) => {
      idleLease = true;
      try {
        return await operation();
      } finally {
        idleLease = false;
      }
    },
    native,
    workspace,
  });
  const service = createNativePluginService({
    homeDir: f.root,
    env: {},
    access,
    command: () => ({ command: process.execPath, args: [] }),
    getProject: () => Promise.resolve(project),
    onChanged: () => {
      changedUnderLease = idleLease;
    },
    run: (_exe, args) =>
      Promise.resolve({
        stdout: Buffer.from(
          args[0] === '--version'
            ? '2.1.317'
            : args[1] === 'list'
              ? '[]'
              : JSON.stringify({ shownCommand: { command: 'fixture-path', sha256: 'a'.repeat(64) } }),
        ),
        stderr: Buffer.alloc(0),
        exitCode: args[1] === 'install' ? 1 : 0,
      }),
  });
  const c = await service.read('claude', project),
    task = await service.prepare(
      'claude',
      { action: 'install', source: 'demo@fixture', revision: c.revision },
      project,
    );
  expect((await end(service, 'claude', task, project)).status).toBe('awaiting-confirmation');
  expect(idleLease).toBe(true);
  await expect(native.run('claude', () => Promise.resolve())).rejects.toThrow();
  await expect(workspace.withIdle(project.id, () => Promise.resolve())).rejects.toThrow();
  expect((await service.read('claude', project)).operations[0]!.operationId).toBe(task.operationId);
  service.cancel('claude', project, task.operationId);
  await service.dispose();
  expect(idleLease).toBe(false);
  expect(changedUnderLease).toBe(true);
  await workspace.withIdle(project.id, () => Promise.resolve());
});
it('Codex 配置层通过真实受控 app-server 读取，只返回插件策略字段', async () => {
  const f = await fixture(),
    script = path.join(f.root, 'codex-fixture.cjs');
  await f.put(
    script,
    `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;const result=q.method==='config/read'?{config:{plugins:{'demo@fixture':{enabled:false}},api_key:'private-secret'},layers:[{name:{type:'enterpriseManaged',id:'policy'},version:'v1',config:{plugins:{'demo@fixture':{enabled:false}},api_key:'private-secret'}}]}:{};process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');});`,
  );
  const policy = await codexPluginPolicy({ agent: 'codex', homeDir: f.root, env: { AGENTDECK_CODEX: script } });
  expect(policy).toMatchObject({
    verified: true,
    enabled: { 'demo@fixture': { enabled: false } },
    layers: [{ kind: 'enterpriseManaged', plugins: { 'demo@fixture': { enabled: false } } }],
  });
  expect(JSON.stringify(policy)).not.toContain('private-secret');
});
it('能力失效仍在进行时不提前发布终态，重开列表可以持续跟踪', async () => {
  const f = await fixture();
  let release!: () => void,
    invalidating = false,
    enabled = true;
  const native = createCliActivity(),
    workspace = createWorkspaceActivity();
  const service = createNativePluginService({
    homeDir: f.root,
    env: {},
    access: createNativeManagementAccess({ withIdleAgent: (_agent, operation) => operation(), native, workspace }),
    command: () => ({ command: process.execPath, args: [] }),
    onChanged: () => {
      invalidating = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    run: (_exe, args) => {
      if (args[1] === 'disable') enabled = false;
      return Promise.resolve({
        stdout: Buffer.from(
          args[0] === '--version'
            ? '2.1.317'
            : args[1] === 'list'
              ? JSON.stringify([
                  {
                    id: 'demo@fixture',
                    scope: 'user',
                    installPath: path.join(f.root, 'plugin'),
                    version: '1',
                    enabled,
                  },
                ])
              : '{}',
        ),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      });
    },
  });
  const entry = (await service.read('claude')).entries[0]!,
    task = await service.prepare('claude', { action: 'disable', id: entry.id, revision: entry.revision });
  await service.start('claude', { operationId: task.operationId, revision: task.revision });
  for (let n = 0; n < 100 && !invalidating; n++) await new Promise((r) => setTimeout(r, 5));
  try {
    expect(service.operation('claude', undefined, task.operationId).status).toBe('running');
    expect((await service.read('claude')).operations[0]!.operationId).toBe(task.operationId);
  } finally {
    release();
    await service.dispose();
  }
});
it('取消与原生命令确认准备竞争时，不重新进入等待确认', async () => {
  const f = await fixture();
  let refused = false,
    release: (() => void) | undefined;
  const service = createNativePluginService({
    homeDir: f.root,
    env: {},
    command: () => ({ command: process.execPath, args: [] }),
    run: async (_exe, args) => {
      if (args[1] === 'install') {
        refused = true;
        return {
          stdout: Buffer.from(JSON.stringify({ shownCommand: { command: 'fixture-tool', sha256: 'a'.repeat(64) } })),
          stderr: Buffer.alloc(0),
          exitCode: 1,
        };
      }
      if (args[1] === 'list' && refused) {
        refused = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { stdout: Buffer.from(args[0] === '--version' ? '2.1.317' : '[]'), stderr: Buffer.alloc(0), exitCode: 0 };
    },
  });
  const c = await service.read('claude'),
    task = await service.prepare('claude', { action: 'install', source: 'demo@fixture', revision: c.revision });
  await service.start('claude', { operationId: task.operationId, revision: task.revision });
  for (let n = 0; n < 100 && !release; n++) await new Promise((r) => setTimeout(r, 5));
  service.cancel('claude', undefined, task.operationId);
  release!();
  await new Promise((r) => setTimeout(r, 30));
  try {
    expect(service.operation('claude', undefined, task.operationId).status).toBe('cancelled');
  } finally {
    await service.dispose();
  }
});
