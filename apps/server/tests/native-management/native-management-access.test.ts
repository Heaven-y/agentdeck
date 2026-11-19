import { expect, it, vi } from 'vitest';
import { createNativeManagementAccess } from '../../src/native-management/access';
import { createCliActivity } from '../../src/bootstrap/cli-activity';
import { createWorkspaceActivity } from '../../src/workspaces/activity';
import { createCodexSkills } from '../../src/agents/codex/configuration/skills';
import type { SkillClient } from '../../src/agents/codex/configuration/skills';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

it('写租约顺序固定且只取得一次，读取与安装/维护互斥，项目占用时不进入写入', async () => {
  const native = createCliActivity(),
    workspace = createWorkspaceActivity();
  const order: string[] = [];
  const access = createNativeManagementAccess({
    native,
    workspace,
    withIdleAgent: async (_agent, operation) => {
      order.push('idle');
      return operation();
    },
  });
  let release!: () => void;
  const reading = access.read(
    'codex',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await expect(
    access.write('codex', { id: 'demo', dir: os.tmpdir() }, async () => {
      order.push('write');
    }),
  ).rejects.toMatchObject({ code: 'agent_busy' });
  release();
  await reading;
  const end = workspace.acquire('demo');
  await expect(
    access.write('codex', { id: 'demo', dir: os.tmpdir() }, async () => {
      order.push('write');
    }),
  ).rejects.toThrow('项目正在');
  end();
  await access.write('codex', { id: 'demo', dir: os.tmpdir() }, async () => {
    order.push('write');
    await expect(access.read('codex', async () => {})).rejects.toMatchObject({ code: 'agent_busy' });
    await expect(native.exclusive('codex', async () => {})).rejects.toMatchObject({ code: 'agent_busy' });
  });
  expect(order).toEqual(['idle', 'idle', 'idle', 'write']);
});

it('Codex 只提交已发现绝对路径，重读同 cwd 证明生效；原生有效状态不符不能报成功', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codex-skills-config-'));
  try {
    const file = path.join(cwd, '.agents/skills/demo/SKILL.md');
    let enabled = true;
    const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (method === 'skills/config/write') {
        enabled = params.enabled === true;
        return { effectiveEnabled: enabled };
      }
      return { data: [{ cwd, skills: [{ name: 'demo', path: file, scope: 'repo', enabled }], errors: [] }] };
    });
    const client: SkillClient = { request, initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const skills = createCodexSkills({}, async () => client);
    await skills.write(cwd, file, false);
    expect(request.mock.calls.map((call) => call[0])).toEqual(['skills/list', 'skills/config/write', 'skills/list']);
    expect(request.mock.calls[1]?.[1]).toEqual({ path: file, enabled: false });
    expect(request.mock.calls[2]?.[1]).toEqual({ cwds: [cwd], forceReload: true });
    await expect(skills.write(cwd, path.join(cwd, 'other/SKILL.md'), true)).rejects.toMatchObject({
      code: 'unsupported_action',
    });
    request.mockImplementation(async (method: string) =>
      method === 'skills/config/write'
        ? { effectiveEnabled: true }
        : { data: [{ cwd, skills: [{ name: 'demo', path: file, scope: 'repo', enabled: false }], errors: [] }] },
    );
    await expect(skills.write(cwd, file, true)).rejects.toMatchObject({ code: 'result_unconfirmed' });
    request.mockImplementation(async () => ({
      data: [{ cwd, skills: [{ name: 'demo', path: file, scope: 'repo', enabled: true, source: { type: 'plugin' } }] }],
    }));
    request.mockClear();
    await expect(skills.write(cwd, file, false)).rejects.toMatchObject({ code: 'unsupported_action' });
    expect(request.mock.calls.map(([method]) => method)).toEqual(['skills/list']);
    request
      .mockResolvedValueOnce({ data: [{ cwd, skills: [{ path: file, scope: 'repo', enabled: true }] }] })
      .mockResolvedValueOnce({ effectiveEnabled: false })
      .mockRejectedValueOnce(new Error('目录暂不可读'));
    await expect(skills.write(cwd, file, false)).rejects.toMatchObject({ code: 'result_unconfirmed' });
    const owned = { name: 'demo', path: file, scope: 'repo', enabled: true };
    const alias = `${path.dirname(file)}${path.sep}.${path.sep}SKILL.md`;
    request.mockClear();
    request.mockResolvedValueOnce({ data: [{ cwd, skills: [owned, { ...owned, path: alias, scope: 'admin' }] }] });
    await expect(skills.write(cwd, file, false)).rejects.toMatchObject({ code: 'unsupported_action' });
    expect(request.mock.calls.map(([method]) => method)).toEqual(['skills/list']);
    request
      .mockResolvedValueOnce({ data: [{ cwd, skills: [owned] }] })
      .mockResolvedValueOnce({ effectiveEnabled: false })
      .mockResolvedValueOnce({ data: [{ cwd, skills: [{ ...owned, scope: 'user', enabled: false }] }] });
    await expect(skills.write(cwd, file, false)).rejects.toMatchObject({ code: 'result_unconfirmed' });
    expect(client.close).toHaveBeenCalledTimes(7);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
