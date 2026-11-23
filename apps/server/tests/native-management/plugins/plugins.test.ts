import { pluginHelp } from './plugin-help';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativePluginService } from '../../../src/native-management/plugins/plugin-service';
import type { ProcessRunner } from '../../../src/platform/process/run';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-plugins-'));
  roots.push(root);
  const project = { id: 'demo', dir: path.join(root, 'project') };
  await mkdir(project.dir);
  const records: Array<Record<string, unknown>> = [];
  const commands: string[][] = [];
  let action: ProcessRunner = async () => ({ stdout: Buffer.from('{}'), stderr: Buffer.alloc(0), exitCode: 0 });
  let changes = 0;
  const run: ProcessRunner = async (exe, args, options) => {
    commands.push(args);
    const value = pluginHelp('claude', args) ?? (args[1] === 'list' ? JSON.stringify(records) : null);
    return value === null
      ? action(exe, args, options)
      : { stdout: Buffer.from(value), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  const service = createNativePluginService({
    homeDir: root,
    env: {},
    run,
    command: () => ({ command: process.execPath, args: [] }),
    onChanged: () => {
      changes++;
    },
  });
  const add = (scope = 'user', market = 'fixture') =>
    records.push({
      id: `demo@${market}`,
      scope,
      ...(scope === 'user' ? {} : { projectPath: project.dir }),
      installPath: path.join(root, market, scope),
      version: '1.0.0',
      enabled: true,
    });
  return {
    root,
    project,
    records,
    commands,
    service,
    add,
    setAction: (value: ProcessRunner) => {
      action = value;
    },
    changes: () => changes,
  };
}
async function settled(service: ReturnType<typeof createNativePluginService>, id: string) {
  for (let count = 0; count < 100; count++) {
    const task = service.operation('claude', undefined, id);
    if (!['running', 'cancelling'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('插件任务未在预算内结束');
}
it('同名插件跨作用域和市场身份稳定，revision 变化拒绝旧操作', async () => {
  const f = await fixture();
  f.add();
  f.add('project');
  f.add('user', 'other');
  const catalog = await f.service.read('claude', f.project);
  expect(new Set(catalog.entries.map((e) => e.id)).size).toBe(3);
  const user = catalog.entries.find((e) => e.scope === 'user' && e.selector === 'demo@fixture')!;
  const task = await f.service.prepare(
    'claude',
    { action: 'disable', id: user.id, revision: user.revision },
    f.project,
  );
  f.records[0]!.version = '2.0.0';
  await expect(
    f.service.start('claude', { operationId: task.operationId, revision: task.revision }, f.project),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(f.commands.some((args) => args[1] === 'disable')).toBe(false);
});
it('原生命令确认只批准展示的摘要，重复 start 不重复安装', async () => {
  const f = await fixture();
  const sha = 'a'.repeat(64);
  let executed = 0;
  f.setAction(async (_exe, args) => {
    if (!args.includes('--accept-command'))
      return {
        stdout: Buffer.from(
          JSON.stringify({
            outcome: 'needs_confirmation',
            shownCommand: { command: 'fixture-tool plugin-path', sha256: sha },
          }),
        ),
        stderr: Buffer.alloc(0),
        exitCode: 1,
      };
    executed++;
    f.add();
    return { stdout: Buffer.from('{"outcome":"ok"}'), stderr: Buffer.alloc(0), exitCode: 0 };
  });
  const catalog = await f.service.read('claude');
  const task = await f.service.prepare('claude', {
    action: 'install',
    source: 'demo@fixture',
    scope: 'user',
    revision: catalog.revision,
  });
  expect(f.commands.some((args) => args[1] === 'install')).toBe(false);
  const input = { operationId: task.operationId, revision: task.revision };
  await Promise.all([f.service.start('claude', input), f.service.start('claude', input)]);
  const waiting = await settled(f.service, task.operationId);
  expect(waiting).toMatchObject({
    status: 'awaiting-confirmation',
    shownCommand: { sha256: sha, command: 'fixture-tool plugin-path' },
  });
  expect((await f.service.start('claude', input)).status).toBe('awaiting-confirmation');
  await expect(f.service.start('claude', { ...input, confirmation: 'b'.repeat(64) })).rejects.toMatchObject({
    code: 'plugin_confirmation',
  });
  const approved = { ...input, confirmation: sha };
  await Promise.all([f.service.start('claude', approved), f.service.start('claude', approved)]);
  expect(await settled(f.service, task.operationId)).toMatchObject({ status: 'succeeded', message: undefined });
  await f.service.start('claude', approved);
  expect(executed).toBe(1);
  expect(f.commands.flat()).not.toContain('--yes');
});
it('部分失败仍重读真实状态并失效能力，关闭页面后的操作可恢复', async () => {
  const f = await fixture();
  f.add();
  f.setAction(async () => {
    f.records[0]!.enabled = false;
    return { stdout: Buffer.alloc(0), stderr: Buffer.from('private-secret'), exitCode: 1 };
  });
  const entry = (await f.service.read('claude')).entries[0]!;
  const task = await f.service.prepare('claude', { action: 'disable', id: entry.id, revision: entry.revision });
  await f.service.start('claude', { operationId: task.operationId, revision: task.revision });
  expect((await settled(f.service, task.operationId)).status).toBe('unknown');
  const reopened = await f.service.read('claude');
  expect(reopened.entries[0]!.enabled).toBe(false);
  expect(reopened.operations[0]!.operationId).toBe(task.operationId);
  expect(JSON.stringify(reopened)).not.toContain('private-secret');
  expect(f.changes()).toBe(1);
});
it('取消等待进程退出再释放维护租约，终态不再次安装', async () => {
  const f = await fixture();
  let exited = false;
  f.setAction(
    async (_exe, _args, options) =>
      new Promise((_resolve, reject) => {
        options.signal!.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              exited = true;
              reject(new Error('aborted'));
            }, 10);
          },
          { once: true },
        );
      }),
  );
  const c = await f.service.read('claude');
  const task = await f.service.prepare('claude', {
    action: 'install',
    source: 'demo@fixture',
    scope: 'user',
    revision: c.revision,
  });
  const input = { operationId: task.operationId, revision: task.revision };
  await f.service.start('claude', input);
  await new Promise((resolve) => setTimeout(resolve, 10));
  f.service.cancel('claude', undefined, task.operationId);
  expect((await settled(f.service, task.operationId)).status).toBe('cancelled');
  expect(exited).toBe(true);
  await f.service.start('claude', input);
  expect(f.commands.filter((a) => a[1] === 'install')).toHaveLength(1);
});
it('拒绝选项注入、带凭据来源及跨项目 operationId', async () => {
  const f = await fixture();
  const c = await f.service.read('claude');
  for (const source of ['--help', 'https://user:secret@example.com/repo', 'demo@fixture\n--yes'])
    await expect(
      f.service.prepare('claude', { action: 'install', source, scope: 'user', revision: c.revision }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  const task = await f.service.prepare('claude', {
    action: 'install',
    source: 'demo@fixture',
    scope: 'user',
    revision: c.revision,
  });
  await expect(
    f.service.start('claude', { operationId: task.operationId, revision: task.revision }, f.project),
  ).rejects.toMatchObject({ code: 'plugin_operation_missing' });
});
it('退出码成功但原生安装结果不存在时保留未知，不误报完成', async () => {
  const f = await fixture();
  const c = await f.service.read('claude');
  const task = await f.service.prepare('claude', {
    action: 'install',
    source: 'demo@fixture',
    scope: 'user',
    revision: c.revision,
  });
  await f.service.start('claude', { operationId: task.operationId, revision: task.revision });
  expect((await settled(f.service, task.operationId)).status).toBe('unknown');
});
it('Claude 列表只纳入当前目录的项目安装，不能操作其他项目同名插件', async () => {
  const f = await fixture();
  f.add();
  f.add('project');
  f.records[1]!.projectPath = f.project.dir;
  f.add('local');
  f.records[2]!.projectPath = path.join(f.root, 'other');
  const catalog = await f.service.read('claude', f.project);
  expect(catalog.entries.map((e) => e.scope)).toEqual(['user', 'project']);
  expect((await f.service.read('claude')).entries.map((e) => e.scope)).toEqual(['user']);
});
it('Claude 配置只回需求和已配置状态，秘密仅通过 stdin 写入', async () => {
  const f = await fixture();
  f.add();
  f.records[0]!.hasUserConfig = true;
  let input = '';
  f.setAction(async (_exe, args, options) => {
    if (args.includes('--values-stdin')) input = String(options.input);
    return {
      stdout: Buffer.from(
        JSON.stringify({
          schema: { token: { type: 'string', title: '令牌', sensitive: true, default: 'secret-default' } },
          inputs: { token: 'secret-old' },
          configured: input ? ['token'] : [],
        }),
      ),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    };
  });
  const entry = (await f.service.read('claude')).entries[0]!;
  const detail = await f.service.detail('claude', entry.id, entry.revision);
  expect(JSON.stringify(detail)).not.toContain('secret-');
  expect(detail.configurationRevision).toMatch(/^[a-f0-9]{64}$/);
  const task = await f.service.prepare('claude', {
    action: 'configure',
    id: entry.id,
    revision: entry.revision,
    configurationRevision: detail.configurationRevision,
    values: { token: 'secret-new' },
  });
  await f.service.start('claude', { operationId: task.operationId, revision: task.revision });
  expect((await settled(f.service, task.operationId)).status).toBe('succeeded');
  expect(input).toBe('{"token":"secret-new"}');
  expect(JSON.stringify(f.commands)).not.toContain('secret-');
});
it('Claude 配置在预览后被外部修改时拒绝覆盖秘密', async () => {
  const f = await fixture();
  f.add();
  f.records[0]!.hasUserConfig = true;
  let secret = 'original',
    writes = 0;
  f.setAction((_exe, args) => {
    if (args.includes('--values-stdin')) writes++;
    return Promise.resolve({
      stdout: Buffer.from(
        JSON.stringify({
          schema: { token: { type: 'string', sensitive: true } },
          inputs: { token: secret },
          configured: ['token'],
        }),
      ),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    });
  });
  const entry = (await f.service.read('claude')).entries[0]!,
    detail = await f.service.detail('claude', entry.id, entry.revision);
  const task = await f.service.prepare('claude', {
    action: 'configure',
    id: entry.id,
    revision: entry.revision,
    configurationRevision: detail.configurationRevision,
    values: { token: 'new' },
  });
  secret = 'external';
  await expect(
    f.service.start('claude', { operationId: task.operationId, revision: task.revision }),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(writes).toBe(0);
});
