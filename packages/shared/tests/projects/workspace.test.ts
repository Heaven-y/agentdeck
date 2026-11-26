import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceInputSchema, WorkspaceSchema } from '../../src/projects/workspace';

describe('WorkspaceInputSchema', () => {
  const base = { name: '示例项目', dir: path.join(tmpdir(), 'agentdeck-fixture', '项目 a') };
  it('接受只有名称和目录的最小工作区', () => {
    expect(WorkspaceInputSchema.parse(base)).toEqual(base);
  });

  it('拒绝空名称与空目录', () => {
    expect(WorkspaceInputSchema.safeParse({ ...base, name: '  ' }).success).toBe(false);
    expect(WorkspaceInputSchema.safeParse({ name: 'x', dir: '' }).success).toBe(false);
  });

  it('项目输入只读取名称和目录，丢弃服务器绑定等无关字段', () => {
    const parsed = WorkspaceInputSchema.parse({
      ...base,
      localDir: base.dir,
      sshHost: 'my-server',
      server: 'my-server',
      remoteDir: '~/projects/demo',
      sync: { mode: 'bisync' },
      policy: { disabledRules: ['privilege'] },
    });
    expect(parsed).toEqual(base);
  });

  it('工作区不承载认证方式与密码，未知字段一律丢弃', () => {
    for (const extra of [{ authMode: 'password' }, { password: 'test-secret' }, { authMode: 'automatic' }])
      expect(WorkspaceInputSchema.parse({ ...base, ...extra })).toEqual(base);
  });
});

describe('WorkspaceSchema', () => {
  it('要求 id 非空', () => {
    const base = { name: '示例项目', dir: path.join(tmpdir(), 'agentdeck-fixture', 'demo') };
    expect(WorkspaceSchema.safeParse({ ...base, id: '' }).success).toBe(false);
    expect(WorkspaceSchema.parse({ ...base, id: 'w1' }).id).toBe('w1');
  });
});
