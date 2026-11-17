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

  it('项目输入只读取名称和目录，丢弃服务器绑定等无关字段', () => {
    const parsed = WorkspaceInputSchema.parse({
      name: '示例项目',
      dir: '/tmp/demo',
      server: 'my-server',
      remoteDir: '~/projects/demo',
    });
    expect(parsed).toEqual({ name: '示例项目', dir: '/tmp/demo' });
  });
});

describe('WorkspaceSchema', () => {
  it('要求 id 非空', () => {
    expect(WorkspaceSchema.safeParse({ id: '', name: '示例项目', dir: '/tmp/demo' }).success).toBe(false);
    expect(WorkspaceSchema.parse({ id: 'w1', name: '示例项目', dir: '/tmp/demo' }).id).toBe('w1');
  });
});
