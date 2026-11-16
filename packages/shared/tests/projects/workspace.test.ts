import { describe, expect, it } from 'vitest';
import { WorkspaceInputSchema, WorkspaceSchema } from '../../src/projects/workspace';

describe('WorkspaceInputSchema', () => {
  it('接受只有名称和目录的最小工作区', () => {
    const parsed = WorkspaceInputSchema.parse({ name: '示例项目', dir: 'E:\\web\\demo' });
    expect(parsed).toEqual({ name: '示例项目', dir: 'E:\\web\\demo' });
  });

  it('拒绝空名称与空目录', () => {
    expect(WorkspaceInputSchema.safeParse({ name: '  ', dir: '/tmp' }).success).toBe(false);
    expect(WorkspaceInputSchema.safeParse({ name: 'x', dir: '' }).success).toBe(false);
  });

  it('丢弃旧格式的 sync、policy、sshHost、localDir 与服务器绑定字段', () => {
    const parsed = WorkspaceInputSchema.parse({
      name: '旧项目',
      dir: '/tmp/demo',
      sshHost: 'my-server',
      localDir: '/tmp/demo',
      sync: { mode: 'bisync' },
      policy: { disabledRules: ['privilege'] },
    });
    // 服务器绑定不属于项目：旧配置里的 server / remoteDir 与其它旧键一样被丢弃，
    // 让旧文件能直接读入而不报错。
    expect(parsed).toEqual({ name: '旧项目', dir: '/tmp/demo' });
  });
});

describe('WorkspaceSchema', () => {
  it('要求 id 非空', () => {
    expect(WorkspaceSchema.safeParse({ id: '', name: '示例项目', dir: '/tmp/demo' }).success).toBe(false);
    expect(WorkspaceSchema.parse({ id: 'w1', name: '示例项目', dir: '/tmp/demo' }).id).toBe('w1');
  });
});
