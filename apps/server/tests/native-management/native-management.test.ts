import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeManagementService } from '../../src/native-management/skills/service';
import { skillAdapters } from '../../src/native-management/skills/adapters';
import type { NativeSkill } from '../../src/native-management/skills/types';
import { verifiedSkillVersion } from '../../src/native-management/version';
import { NativeManagementError } from '../../src/native-management/errors';
import { createNativeResourcesService } from '../../src/settings/resources/native-resources';
import { claudeSkillsFromPlugins } from '../../src/agents/claude/configuration/skills';

it('预发行版不是已核实的稳定版，不能开启 Skills 结构化写入', async () => {
  const ctx = { agent: 'antigravity' as const, homeDir: os.tmpdir(), env: process.env };
  const resolve = (output: string) => () => ({
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(output)})`, '--'],
  });
  await expect(verifiedSkillVersion(ctx, '1.5.3', resolve('1.5.3'))).resolves.toBe(true);
  await expect(verifiedSkillVersion(ctx, '1.5.3', resolve('1.5.3-beta.1'))).resolves.toBe(false);
});

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'native-management-'));
  temporary.push(homeDir);
  const project = { id: 'demo', dir: path.join(homeDir, 'project') };
  await mkdir(project.dir);
  const native = vi.fn(async (): Promise<NativeSkill[]> => []);
  const changed = vi.fn(async () => {});
  const reads = { readNative: native, verifyVersion: async () => true };
  const adapters = {
    claude: { ...skillAdapters.claude, ...reads },
    codex: { ...skillAdapters.codex, ...reads },
    antigravity: { ...skillAdapters.antigravity, ...reads },
  };
  const service = createNativeManagementService({ homeDir, env: {}, adapters, onChanged: changed });
  async function skill(relative: string, name = 'demo') {
    const file = path.join(homeDir, relative, 'SKILL.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `---\nname: ${name}\ndescription: 测试技能\n---\n# Skill\n`);
    return file;
  }
  return { homeDir, project, service, adapters, native, changed, skill };
}

it('Claude 同名来源身份独立，四态设置明确写入所选作用域，默认继承不会被 on 替代', async () => {
  const { service, skill, project, homeDir } = await fixture();
  await skill('.claude/skills/demo');
  await skill('project/.claude/skills/demo');
  await writeFile(
    path.join(homeDir, '.claude/settings.json'),
    JSON.stringify({ skillOverrides: { demo: 'name-only' } }),
  );
  const list = await service.readSkills('claude', project);
  expect(new Set(list.entries.map((e) => e.id)).size).toBe(2);
  const entry = list.entries.find((e) => e.scope === 'project')!;
  expect(entry.actions.states).toEqual(['inherit', 'on', 'name-only', 'user-invocable-only', 'off']);
  await service.changeSkill(
    'claude',
    { id: entry.id, revision: entry.revision, action: 'state', value: 'user-invocable-only', scope: 'local' },
    project,
  );
  const file = path.join(homeDir, 'project/.claude/settings.local.json');
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ skillOverrides: { demo: 'user-invocable-only' } });
  const next = (await service.readSkills('claude', project)).entries.find((e) => e.id === entry.id)!;
  expect(next).toMatchObject({
    state: 'user-invocable-only',
    stateByScope: { user: 'name-only', project: 'inherit', local: 'user-invocable-only' },
  });
  await service.changeSkill(
    'claude',
    { id: next.id, revision: next.revision, action: 'state', value: 'inherit', scope: 'local' },
    project,
  );
  expect(JSON.parse(await readFile(file, 'utf8')).skillOverrides).toEqual({});
  const inherited = await service.readSkills('claude', project);
  expect(inherited.entries.map((item) => item.state)).toEqual(['name-only', 'name-only']);
  await writeFile(file, '{"skillOverrides":[]}');
  const invalid = (await service.readSkills('claude', project)).entries.find((item) => item.id === entry.id)!;
  expect(invalid.state).toBe('unknown');
  expect(invalid.actions.states).toEqual([]);
});

it('AGY 仅标准根技能使用本层原生清单，其他自有技能只提供文件操作', async () => {
  const { service, skill, project, native } = await fixture();
  await skill('.gemini/skills/shared', 'shared');
  await skill('.gemini/antigravity-cli/skills/private', 'private');
  const demo = await skill('project/.agents/skills/demo');
  const legacy = await skill('project/.agent/skills/legacy', 'legacy');
  const file = path.join(project.dir, '.agents/skills.json');
  native.mockImplementation(async () => [
    { name: 'legacy', path: legacy, enabled: true },
    ...(JSON.parse(await readFile(file, 'utf8')).exclude.includes('demo')
      ? []
      : [{ name: 'demo', path: demo, enabled: true }]),
  ]);
  await writeFile(file, JSON.stringify({ unknown: true, exclude: [] }));
  const list = await service.readSkills('antigravity', project);
  expect(
    list.entries.filter((e) => ['shared', 'private'].includes(e.name)).every((e) => e.actions.states.length === 0),
  ).toBe(true);
  expect(list.entries.find((e) => e.name === 'legacy')?.actions).toMatchObject({ edit: true, states: [] });
  const entry = list.entries.find((e) => e.name === 'demo')!;
  await service.changeSkill(
    'antigravity',
    { id: entry.id, revision: entry.revision, action: 'state', value: 'disabled', scope: 'project' },
    project,
  );
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ unknown: true, exclude: ['demo'] });
});

it('插件与管理员技能只读，Codex 同路径来源冲突不开放操作且使旧 revision 失效', async () => {
  const { homeDir, service, native, project, skill } = await fixture();
  const own = await skill('project/.agents/skills/demo');
  native.mockResolvedValue([
    { name: 'demo', path: own, scope: 'project', enabled: true },
    { name: 'demo', path: path.join(homeDir, 'managed/SKILL.md'), scope: 'admin', origin: 'managed', enabled: true },
    { name: 'plug:demo', origin: 'plugin', enabled: true },
  ]);
  const entries = (await service.readSkills('codex', project)).entries;
  expect(entries.find((e) => e.origin === 'managed')?.actions).toMatchObject({ delete: false, states: [] });
  expect(entries.find((e) => e.origin === 'plugin')?.actions).toMatchObject({ delete: false, states: [] });
  const local = entries.find((e) => e.scope === 'project')!;
  expect(local.actions).toMatchObject({ states: ['enabled', 'disabled'], stateScopes: ['user'] });
  expect(local).not.toHaveProperty('nativePath');
  await expect(
    service.changeSkill(
      'codex',
      { id: local.id, revision: local.revision, action: 'state', scope: 'project', value: 'disabled' },
      project,
    ),
  ).rejects.toMatchObject({ code: 'unsupported_action' });
  const matches: NativeSkill[] = [
    { name: 'demo', path: own, scope: 'project', enabled: true },
    { name: 'plug:demo', path: own, scope: 'user', origin: 'plugin', enabled: true },
  ];
  native.mockResolvedValue(matches);
  const ambiguous = (await service.readSkills('codex', project)).entries.find((item) => item.id === local.id)!;
  expect(ambiguous.actions).toEqual({ edit: false, delete: false, states: [], stateScopes: [] });
  expect(ambiguous.state).toBe('unknown');
  native.mockResolvedValue([...matches].reverse());
  const reordered = (await service.readSkills('codex', project)).entries.find((item) => item.id === local.id)!;
  expect(reordered).toEqual(ambiguous);
  const deletion = { id: local.id, revision: local.revision, action: 'delete', confirmation: local.name } as const;
  await expect(service.changeSkill('codex', deletion, project)).rejects.toMatchObject({ code: 'revision_conflict' });
  await expect(
    service.changeSkill('codex', { ...deletion, revision: ambiguous.revision }, project),
  ).rejects.toMatchObject({
    code: 'unsupported_action',
  });
  expect(await readFile(own, 'utf8')).toContain('# Skill');
});

it('目录导入保留多文件与二进制，路径越界/深度/超量/链接拒绝，删除须确认且 revision 覆盖整个目录', async () => {
  const { service, project, homeDir, changed } = await fixture();
  const root = (await service.readSkills('claude', project)).roots.find((e) => e.scope === 'project')!;
  const files = [
    { path: 'SKILL.md', contentBase64: Buffer.from('---\nname: demo\n---\n# Demo').toString('base64') },
    { path: 'assets/icon.bin', contentBase64: Buffer.from([0, 255, 1]).toString('base64') },
  ];
  await service.importSkill('claude', { rootId: root.id, name: 'demo', files }, project);
  const directory = path.join(project.dir, '.claude/skills/demo');
  expect(await readFile(path.join(directory, 'assets/icon.bin'))).toEqual(Buffer.from([0, 255, 1]));
  const entry = (await service.readSkills('claude', project)).entries[0]!;
  await expect(
    service.changeSkill('claude', { id: entry.id, revision: entry.revision, action: 'delete' }, project),
  ).rejects.toMatchObject({ code: 'confirmation_required' });
  await writeFile(path.join(directory, 'assets/icon.bin'), 'changed');
  await expect(
    service.changeSkill(
      'claude',
      { id: entry.id, revision: entry.revision, action: 'delete', confirmation: 'demo' },
      project,
    ),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  for (const file of ['../outside', 'a\\b', 'a/b/c/d/e/f/g.txt'])
    await expect(
      service.importSkill(
        'claude',
        { rootId: root.id, name: 'bad', files: [...files, { path: file, contentBase64: 'YQ==' }] },
        project,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(
    service.importSkill(
      'claude',
      {
        rootId: root.id,
        name: 'huge',
        files: [...files, { path: 'large', contentBase64: Buffer.alloc(1024 * 1024 + 1).toString('base64') }],
      },
      project,
    ),
  ).rejects.toMatchObject({ code: 'too_large' });
  await symlink(homeDir, path.join(directory, 'linked'), 'junction');
  const linked = (await service.readSkills('claude', project)).entries[0]!;
  expect(linked.actions.delete).toBe(false);
  await unlink(path.join(directory, 'linked'));
  const current = (await service.readSkills('claude', project)).entries[0]!;
  await service.changeSkill(
    'claude',
    { id: current.id, revision: current.revision, action: 'delete', confirmation: current.name },
    project,
  );
  await expect(readFile(path.join(directory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(changed).toHaveBeenCalled();
});

it('并发导入不覆盖已有目录，状态 revision 冲突不覆盖外部设置', async () => {
  const { service, project, skill } = await fixture();
  await skill('project/.claude/skills/demo');
  const old = (await service.readSkills('claude', project)).entries[0]!;
  const file = path.join(project.dir, '.claude/settings.local.json');
  await writeFile(file, '{"unknown":true}');
  await expect(
    service.changeSkill(
      'claude',
      { id: old.id, revision: old.revision, action: 'state', value: 'off', scope: 'local' },
      project,
    ),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  const root = (await service.readSkills('claude', project)).roots.find((e) => e.scope === 'project')!;
  const input = { rootId: root.id, name: 'other', files: [{ path: 'SKILL.md', contentBase64: 'IyBTa2lsbA==' }] };
  const result = await Promise.allSettled([
    service.importSkill('claude', input, project),
    service.importSkill('claude', input, project),
  ]);
  expect(result.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
});

it('可能部分写入的失败也失效原生能力与实例，原生读取失败不提供Codex伪开关', async () => {
  const { project, skill, native, changed, service, adapters } = await fixture();
  const file = await skill('project/.agents/skills/demo');
  native.mockResolvedValue([{ name: 'demo', path: file, scope: 'project', enabled: true }]);
  const change = vi
    .spyOn(adapters.codex, 'changeState')
    .mockRejectedValue(new NativeManagementError('result_unconfirmed'));
  const entry = (await service.readSkills('codex', project)).entries[0]!;
  await expect(
    service.changeSkill(
      'codex',
      { id: entry.id, revision: entry.revision, action: 'state', scope: 'user', value: 'disabled' },
      project,
    ),
  ).rejects.toMatchObject({ code: 'result_unconfirmed' });
  expect(changed).toHaveBeenCalledExactlyOnceWith('codex');
  expect(change).toHaveBeenCalledOnce();
  native.mockRejectedValue(new Error('sentinel-private'));
  const result = await service.readSkills('codex', project);
  expect(result.entries[0]?.actions.states).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('sentinel-private');
});

it('Hooks与代理定义保留实际来源，项目插件资产的原文入口只读', async () => {
  const { homeDir, project } = await fixture();
  const directory = path.join(project.dir, '.agents/plugins/demo/agents');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'helper.md'), '# Helper');
  const service = createNativeResourcesService({ homeDir, env: {} });
  const catalog = await service.list('antigravity', project);
  expect(catalog.entries).toContainEqual(
    expect.objectContaining({ kind: 'agents', displayPath: '.agents/agents.json', scope: 'project' }),
  );
  const agent = catalog.entries.find((entry) => entry.displayPath === '.agents/plugins/demo/agents/helper.md')!;
  expect(agent.editable).toBe(false);
  const document = await service.open('antigravity', agent.id, project);
  await expect(
    service.save('antigravity', agent.id, { content: 'overwrite', revision: document.revision }, project),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  const claude = await service.list('claude', project);
  expect(
    claude.entries
      .filter((entry) => entry.displayPath === '.claude/settings.local.json')
      .map((entry) => entry.kind)
      .sort(),
  ).toEqual(['hooks', 'settings']);
});

it('未核实CLI版本保留本地文件编辑，状态开关保持关闭', async () => {
  const { service, project, skill, adapters } = await fixture();
  await skill('project/.claude/skills/demo');
  adapters.claude.verifyVersion = async () => false;
  const result = await service.readSkills('claude', project);
  expect(result.entries[0]).toMatchObject({ state: 'unknown', actions: { edit: true, delete: true, states: [] } });
  expect(result.warnings).toHaveLength(1);
});

it('Claude @skills-dir 插件保留根身份，技能管理和原文入口均不改写或删除插件资产', async () => {
  const { homeDir, project, skill, native, service } = await fixture();
  const file = await skill('project/.claude/skills/local-plugin', 'local-plugin');
  const root = path.dirname(file);
  await mkdir(path.join(root, '.claude-plugin'));
  await writeFile(path.join(root, '.claude-plugin/plugin.json'), '{"name":"local-plugin"}');
  const plugin = { id: 'local-plugin@skills-dir', installPath: root, scope: 'project', enabled: true };
  native.mockResolvedValue(await claudeSkillsFromPlugins([plugin]));
  const entry = (await service.readSkills('claude', project)).entries.find((e) => e.resourceId)!;
  expect(entry).toMatchObject({ origin: 'plugin', actions: { edit: false, delete: false, states: [] } });
  await expect(
    service.changeSkill(
      'claude',
      { id: entry.id, revision: entry.revision, action: 'delete', confirmation: entry.name },
      project,
    ),
  ).rejects.toMatchObject({ code: 'unsupported_action' });
  const resources = createNativeResourcesService({ homeDir, env: {} });
  const raw = (await resources.list('claude', project)).entries.find(
    (e) => e.displayPath === '.claude/skills/local-plugin/SKILL.md',
  )!;
  expect(raw.editable).toBe(false);
  const document = await resources.open('claude', raw.id, project);
  await expect(
    resources.save('claude', raw.id, { revision: document.revision, content: 'overwrite' }, project),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  expect(await readFile(path.join(root, '.claude-plugin/plugin.json'), 'utf8')).toContain('local-plugin');
});

it('AGY 清单选择目录身份，展示名不同也能禁用并从原生目录确认结果', async () => {
  const { project, skill, native, service } = await fixture();
  const file = await skill('project/.agents/skills/directory-name', 'advertised-name');
  const manifest = path.join(project.dir, '.agents/skills.json');
  native.mockImplementation(async () => {
    const config = JSON.parse(await readFile(manifest, 'utf8').catch(() => '{}'));
    return config.exclude?.includes('directory-name') ? [] : [{ name: 'advertised-name', path: file, enabled: true }];
  });
  const entry = (await service.readSkills('antigravity', project)).entries[0]!;
  await service.changeSkill(
    'antigravity',
    { id: entry.id, revision: entry.revision, action: 'state', scope: 'project', value: 'disabled' },
    project,
  );
  expect(JSON.parse(await readFile(manifest, 'utf8')).exclude).toEqual(['directory-name']);
  const disabled = (await service.readSkills('antigravity', project)).entries[0]!;
  expect(disabled).toMatchObject({ name: 'advertised-name', state: 'disabled' });
  await service.changeSkill(
    'antigravity',
    { id: disabled.id, revision: disabled.revision, action: 'state', scope: 'project', value: 'enabled' },
    project,
  );
  expect((await service.readSkills('antigravity', project)).entries[0]?.state).toBe('enabled');
  native.mockResolvedValue([{ name: 'advertised-name', path: file, enabled: true }]);
  const current = (await service.readSkills('antigravity', project)).entries[0]!;
  await expect(
    service.changeSkill(
      'antigravity',
      { id: current.id, revision: current.revision, action: 'state', scope: 'project', value: 'disabled' },
      project,
    ),
  ).rejects.toMatchObject({ code: 'result_unconfirmed' });
  const after = (await service.readSkills('antigravity', project)).entries[0]!;
  expect(after.state).toBe('enabled');
  native
    .mockResolvedValueOnce([{ name: 'advertised-name', path: file, enabled: true }])
    .mockRejectedValueOnce(new Error('目录暂不可读'));
  const disable = {
    id: after.id,
    revision: after.revision,
    action: 'state',
    scope: 'project',
    value: 'disabled',
  } as const;
  await expect(service.changeSkill('antigravity', disable, project)).rejects.toMatchObject({
    code: 'result_unconfirmed',
  });
  // 命令目录按原生名称择一展示，目标消失也可能是被同名的其他路径遮蔽。
  const otherFile = await skill('.gemini/skills/another-directory', 'advertised-name');
  native
    .mockResolvedValueOnce([{ name: 'advertised-name', path: file, enabled: true }])
    .mockResolvedValueOnce([{ name: 'advertised-name', path: otherFile, enabled: true }]);
  await expect(service.changeSkill('antigravity', disable, project)).rejects.toMatchObject({
    code: 'result_unconfirmed',
  });
});

it('AGY 按目录名识别冲突，写入前再次合并来源', async () => {
  const { service, project, skill, native } = await fixture();
  const first = await skill('project/.agents/skills/demo', 'project-name');
  native.mockResolvedValue([{ name: 'project-name', path: first, enabled: true }]);
  const initial = (await service.readSkills('antigravity', project)).entries[0]!;
  expect(initial.actions.stateScopes).toEqual(['project']);
  await skill('.gemini/config/skills/demo', 'global-name');
  const entries = (await service.readSkills('antigravity', project)).entries;
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.actions).toMatchObject({ edit: true, states: [], stateScopes: [] });
    expect(entry.unavailableReason).toContain('同名');
  }
  await expect(
    service.changeSkill(
      'antigravity',
      { id: initial.id, revision: initial.revision, action: 'state', value: 'disabled', scope: 'project' },
      project,
    ),
  ).rejects.toMatchObject({ code: 'unsupported_action' });
  await expect(readFile(path.join(project.dir, '.agents/skills.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
