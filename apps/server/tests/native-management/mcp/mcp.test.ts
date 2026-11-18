import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeMcpService } from '../../../src/native-management/mcp/mcp-service';
import type { NativeManagementAccess } from '../../../src/native-management/access';
import * as executable from '../../../src/platform/process/executable';
import { mcpPluginsFromRecords } from '../../../src/native-management/mcp/mcp-plugins';
import { stringify as stringifyToml } from 'smol-toml';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
it('Claude 原生命令补默认参数后仍确认成功，混合状态未知字段保留', async () => {
  const f = await fixture();
  const file = path.join(f.homeDir, '.claude.json');
  await f.write(file, JSON.stringify({ unknown: 'preserve' }));
  vi.spyOn(executable, 'resolveLocalCommand').mockReturnValue({ command: 'fixture', args: [] });
  const run = vi.fn(async (_command: string, args: string[]) => {
    const index = args.indexOf('add-json');
    const value = JSON.parse(args[index + 2]!);
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.mcpServers = { demo: { type: value.type, command: value.command, args: [] } };
    await writeFile(file, JSON.stringify(state));
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  const service = createNativeMcpService({ homeDir: f.homeDir, env: {}, run, plugins: async () => [] });
  const source = (await service.readMcp('claude')).sources[0]!;
  await expect(
    service.saveMcp('claude', {
      sourceId: source.id,
      revision: source.revision,
      name: 'demo',
      config: { transport: 'stdio', command: 'node' },
    }),
  ).resolves.toMatchObject({ status: 'saved' });
  expect(JSON.parse(await readFile(file, 'utf8')).unknown).toBe('preserve');
});
async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-mcp-'));
  dirs.push(homeDir);
  const project = { id: 'demo', dir: path.join(homeDir, 'project') };
  await mkdir(project.dir);
  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  const run = vi.fn(async () => {
    throw new Error('列表不得运行原生进程');
  });
  const service = createNativeMcpService({ homeDir, env: {}, run, plugins: async () => [] });
  return { homeDir, project, write, service, run };
}
it.each(['claude', 'codex', 'antigravity'] as const)('%s 只将完全匹配的用户会话工具归入专用入口', async (agent) => {
  const f = await fixture();
  const command = { command: 'node', args: ['session-tools.mjs'], env: { EXAMPLE: 'fixture' } };
  const own = agent === 'antigravity' ? { ...command, tools: { read_session: { eager: true } } } : command;
  const files = {
    claude: ['.claude.json', '.mcp.json'],
    codex: ['.codex/config.toml', '.codex/config.toml'],
    antigravity: ['.gemini/config/mcp_config.json', '.agents/mcp_config.json'],
  }[agent];
  const encode = (entry: object) => {
    const data = { [agent === 'codex' ? 'mcp_servers' : 'mcpServers']: { agentdeck_sessions: entry } };
    return agent === 'codex' ? stringifyToml(data) : JSON.stringify(data);
  };
  const userFile = path.join(f.homeDir, files[0]!);
  await f.write(userFile, encode(own));
  await f.write(path.join(f.project.dir, files[1]!), encode(own));
  const service = createNativeMcpService({
    homeDir: f.homeDir,
    env: {},
    sessionToolsCommand: command,
    run: f.run,
    plugins: async () => [
      { name: 'agentdeck_sessions', owner: 'demo', installationRoot: f.project.dir, scope: 'user', config: own },
    ],
  });
  const entries = (await service.readMcp(agent, f.project)).entries;
  const managed = entries.find((entry) => entry.managedBy === 'session-tools')!;
  expect(managed).toMatchObject({
    scope: 'user',
    actions: { edit: false, delete: false, enable: false, disable: false },
  });
  expect(entries.filter((entry) => entry.managedBy === 'session-tools')).toHaveLength(1);
  expect(entries.find((entry) => entry.scope === 'project')?.actions.edit).toBe(true);
  await expect(
    service.operateMcp(agent, { id: managed.id, revision: managed.revision, action: 'delete' }),
  ).rejects.toMatchObject({ code: 'unsupported_action' });
  for (const changed of [
    { ...own, args: ['external.mjs'] },
    { ...own, custom: true },
  ]) {
    await f.write(userFile, encode(changed));
    const external = (await service.readMcp(agent)).entries.find((entry) => !entry.owner)!;
    expect(external.managedBy).toBeUndefined();
    expect(external.actions.delete).toBe(true);
  }
  expect(f.run).not.toHaveBeenCalled();
});
it('离线列表区分真实来源且不回传 URL、参数和环境秘密', async () => {
  const f = await fixture();
  await f.write(
    path.join(f.homeDir, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        demo: {
          type: 'http',
          url: 'https://example.com/secret-path?token=sentinel-secret',
          headers: { Authorization: 'sentinel-secret' },
        },
      },
      projects: {
        [f.project.dir]: {
          mcpServers: { demo: { command: 'node', args: ['sentinel-secret'], env: { TOKEN: 'sentinel-secret' } } },
        },
      },
    }),
  );
  await f.write(path.join(f.project.dir, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'node' } } }));
  const result = await f.service.readMcp('claude', f.project);
  expect(result.entries.map((entry) => entry.scope).sort()).toEqual(['local', 'project', 'user']);
  expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(3);
  expect(JSON.stringify(result)).not.toContain('sentinel-secret');
  expect(JSON.stringify(result)).not.toContain('secret-path');
  expect(f.run).not.toHaveBeenCalled();
});
it('Codex 定点更新保留未知字段、注释与秘密，拒绝过期 revision', async () => {
  const f = await fixture();
  const file = path.join(f.homeDir, '.codex/config.toml');
  await f.write(
    file,
    '# 注释保留\n[mcp_servers.demo]\ncommand = "node"\nargs = ["secret"] # 参数说明\nstartup_timeout_sec = 19\n[mcp_servers.demo.env]\nTOKEN = "secret"\n[unrelated]\nvalue = true\n',
  );
  const [entry] = (await f.service.readMcp('codex')).entries;
  await f.service.saveMcp('codex', {
    id: entry!.id,
    sourceId: entry!.sourceId,
    revision: entry!.revision,
    name: 'demo',
    config: { transport: 'stdio', command: 'new-node' },
  });
  const content = await readFile(file, 'utf8');
  expect(content).toContain('command = "new-node"');
  expect(content).toContain('# 参数说明');
  expect(content).toContain('TOKEN = "secret"');
  expect(content).toContain('startup_timeout_sec = 19');
  await expect(
    f.service.operateMcp('codex', { id: entry!.id, revision: entry!.revision, action: 'delete' }),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
});
it('项目 JSON 保存秘密仅写、保留未知配置，持久禁用与运行状态分离', async () => {
  const f = await fixture();
  const file = path.join(f.project.dir, '.agents/mcp_config.json');
  await f.write(
    file,
    JSON.stringify({
      other: true,
      mcpServers: {
        demo: {
          serverUrl: 'https://example.com/mcp',
          headers: { Authorization: 'old-secret' },
          tools: { read: { eager: true } },
        },
      },
    }),
  );
  const [entry] = (await f.service.readMcp('antigravity', f.project)).entries;
  await f.service.saveMcp(
    'antigravity',
    {
      id: entry!.id,
      sourceId: entry!.sourceId,
      revision: entry!.revision,
      name: 'demo',
      config: { transport: 'http', headers: { Authorization: { action: 'replace', value: 'new-secret' } } },
    },
    f.project,
  );
  const [updated] = (await f.service.readMcp('antigravity', f.project)).entries;
  expect(JSON.stringify(updated)).not.toContain('new-secret');
  await f.service.operateMcp(
    'antigravity',
    { id: updated!.id, revision: updated!.revision, action: 'disable' },
    f.project,
  );
  const raw = JSON.parse(await readFile(file, 'utf8'));
  expect(raw).toMatchObject({
    other: true,
    mcpServers: {
      demo: { disabled: true, headers: { Authorization: 'new-secret' }, tools: { read: { eager: true } } },
    },
  });
  expect((await f.service.readMcp('antigravity', f.project)).entries[0]!.runtime).toBe('unchecked');
});
it('插件资源只读且用户维护动作取得写租约，失败也使缓存失效', async () => {
  const f = await fixture();
  const file = path.join(f.homeDir, '.codex/config.toml');
  await f.write(file, '[mcp_servers.demo]\ncommand = "node"\n');
  const writeLease = vi.fn();
  const access: NativeManagementAccess = {
    read: (_agent, operation) => operation(),
    write: (_agent, _project, operation) => {
      writeLease();
      return operation();
    },
  };
  const changed = vi.fn();
  const service = createNativeMcpService({
    homeDir: f.homeDir,
    env: {},
    access,
    onChanged: changed,
    plugins: async () => [
      {
        name: 'owned',
        owner: 'plugin-demo',
        installationRoot: path.join(f.homeDir, 'plugin'),
        config: { command: 'node' },
      },
    ],
  });
  const catalog = await service.readMcp('codex');
  const plugin = catalog.entries.find((e) => e.owner)!;
  expect(plugin.actions.edit).toBe(false);
  await expect(
    service.operateMcp('codex', { id: plugin.id, revision: plugin.revision, action: 'delete' }),
  ).rejects.toMatchObject({ code: 'unsupported_action' });
  expect(writeLease).toHaveBeenCalled();
  expect(changed).toHaveBeenCalled();
});
it('删除 Codex 内联目标保留同名项目项、兄弟服务与注释', async () => {
  const f = await fixture();
  const file = path.join(f.homeDir, '.codex/config.toml');
  await f.write(
    file,
    '# 保留注释\nmcp_servers = { demo = { command = "node", args = ["a"] }, other = { url = "https://example.com/mcp" } }\n',
  );
  await f.write(path.join(f.project.dir, '.codex/config.toml'), '[mcp_servers.demo]\ncommand = "project-node"\n');
  const catalog = await f.service.readMcp('codex', f.project);
  const user = catalog.entries.find((e) => e.name === 'demo' && e.scope === 'user')!;
  await f.service.operateMcp('codex', { id: user.id, revision: user.revision, action: 'delete' }, f.project);
  const after = await f.service.readMcp('codex', f.project);
  expect(after.entries.map((e) => [e.name, e.scope])).toEqual([
    ['other', 'user'],
    ['demo', 'project'],
  ]);
  expect(await readFile(file, 'utf8')).toContain('# 保留注释');
});
it('秘密显式清除与未知传输只读，畸形秘密映射不被改写', async () => {
  const f = await fixture();
  const file = path.join(f.project.dir, '.mcp.json');
  await f.write(
    file,
    JSON.stringify({
      mcpServers: {
        demo: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'secret', Retained: 'other-secret' },
        },
        websocket: { type: 'ws', url: 'wss://example.com' },
        malformed: { command: 'node', env: 'preserve-me' },
      },
    }),
  );
  const entries = (await f.service.readMcp('claude', f.project)).entries;
  expect(entries.find((e) => e.name === 'websocket')!.actions.edit).toBe(false);
  const bad = entries.find((e) => e.name === 'malformed')!;
  await expect(
    f.service.saveMcp(
      'claude',
      {
        id: bad.id,
        sourceId: bad.sourceId,
        revision: bad.revision,
        name: bad.name,
        config: { transport: 'stdio', env: { TOKEN: { action: 'replace', value: 'new' } } },
      },
      f.project,
    ),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  const entry = entries.find((e) => e.name === 'demo')!;
  await f.service.saveMcp(
    'claude',
    {
      id: entry.id,
      sourceId: entry.sourceId,
      revision: entry.revision,
      name: entry.name,
      config: { transport: 'http', headers: { Authorization: { action: 'clear' } } },
    },
    f.project,
  );
  expect(JSON.parse(await readFile(file, 'utf8')).mcpServers).toMatchObject({
    demo: { headers: { Retained: 'other-secret' } },
    malformed: { env: 'preserve-me' },
  });
  expect(JSON.parse(await readFile(file, 'utf8')).mcpServers.demo.headers.Authorization).toBeUndefined();
});
it('拒绝链接配置目录与旧新增 revision，不越界落盘', async () => {
  const f = await fixture();
  const source = (await f.service.readMcp('codex')).sources[0]!;
  await f.write(path.join(f.homeDir, '.codex/config.toml'), '# external\n');
  await expect(
    f.service.saveMcp('codex', {
      sourceId: source.id,
      revision: source.revision,
      name: 'new',
      config: { transport: 'stdio', command: 'node' },
    }),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  const outside = path.join(f.homeDir, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(f.project.dir, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(f.service.readMcp('antigravity', f.project)).rejects.toMatchObject({ code: 'unsafe_path' });
});
it('Claude 插件内联及相对文件 MCP 保留真实作用域，拒绝越界声明', async () => {
  const f = await fixture();
  const root = path.join(f.homeDir, 'plugin');
  const manifest = path.join(root, '.claude-plugin/plugin.json');
  await f.write(manifest, JSON.stringify({ mcpServers: { inline: { type: 'http', url: 'https://example.com/mcp' } } }));
  const context = { agent: 'claude' as const, homeDir: f.homeDir, env: {}, project: f.project };
  const records = [{ id: 'fixture-plugin', installPath: root, scope: 'project', enabled: true }];
  const entries = await mcpPluginsFromRecords(context, records);
  expect(entries).toMatchObject([{ name: 'inline', owner: 'fixture-plugin', scope: 'project' }]);
  await f.write(manifest, JSON.stringify({ mcpServers: 'config/mcp.json' }));
  await f.write(path.join(root, 'config/mcp.json'), JSON.stringify({ file: { command: 'node' } }));
  expect((await mcpPluginsFromRecords(context, records))[0]!.name).toBe('file');
  await f.write(manifest, JSON.stringify({ mcpServers: '../outside.json' }));
  await expect(mcpPluginsFromRecords(context, records)).rejects.toMatchObject({ code: 'native_unavailable' });
});
it('没有项目时 AGY 只枚举全局，Claude 托管资源不可写', async () => {
  const f = await fixture();
  expect((await f.service.readMcp('antigravity')).sources.map((s) => s.scope)).toEqual(['user']);
  if (process.platform !== 'win32') return;
  await f.write(
    path.join(f.homeDir, 'ClaudeCode/managed-mcp.json'),
    JSON.stringify({ mcpServers: { policy: { command: 'node' } } }),
  );
  await f.write(
    path.join(f.homeDir, 'ClaudeCode/managed-settings.json'),
    JSON.stringify({ managedMcpServers: { policy_http: { type: 'http', url: 'https://example.com/mcp' } } }),
  );
  const service = createNativeMcpService({
    homeDir: f.homeDir,
    env: { ProgramFiles: f.homeDir },
    plugins: async () => [],
  });
  const catalog = await service.readMcp('claude');
  expect(catalog.entries).toHaveLength(2);
  for (const entry of catalog.entries) {
    expect(entry.actions.edit).toBe(false);
    await expect(
      service.operateMcp('claude', { id: entry.id, revision: entry.revision, action: 'delete' }),
    ).rejects.toMatchObject({ code: 'unsupported_action' });
  }
});
