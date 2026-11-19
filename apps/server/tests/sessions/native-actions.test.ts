import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentKind } from '@agentdeck/shared/conversation';
import { expect, it, vi } from 'vitest';
import { createNativeActionsService } from '../../src/sessions/native-actions';

it('父目录链接即使指向工作区内部也不能作为文件回退预览路径', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentdeck-rewind-link-'));
  const source = path.join(dir, 'source'),
    link = path.join(dir, 'link');
  await mkdir(source);
  await writeFile(path.join(source, 'notes.txt'), 'current');
  await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  const service = createNativeActionsService({
    open: async () => ({
      read: async () => ({ revision: 'a'.repeat(64), candidates: [{ id: 'point', label: '输入前' }] }),
      inspect: async () => ({ files: [path.join(link, 'notes.txt')], signature: 'native' }),
      execute: async () => ({ status: 'completed', message: 'done' }),
      close: async () => {},
    }),
    withSession: async (_scope, operation) => operation({ id: 'project', name: 'Fixture', dir }),
    changed: async () => {},
  });
  try {
    await expect(
      service.preview(
        { workspaceId: 'project', agent: 'claude', sessionId: 'native' },
        {
          action: 'rewind-files',
          pointId: 'point',
          revision: 'a'.repeat(64),
        },
      ),
    ).rejects.toThrow();
  } finally {
    await rm(link);
    await rm(dir, { recursive: true, force: true });
  }
});

it('预览只读且绑定会话/原生revision/文件状态，确认后执行一次，重复请求返回同回执', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentdeck-rewind-preview-')),
    file = path.join(dir, 'notes.txt');
  await writeFile(file, 'current');
  let revision = 'a'.repeat(64);
  const execute = vi.fn(async () => ({ status: 'completed' as const, message: 'done' })),
    changed = vi.fn(async () => {});
  const service = createNativeActionsService({
    open: async () => ({
      read: async () => ({ revision, candidates: [{ id: 'point', label: '输入前' }] }),
      inspect: async () => ({ files: [file], signature: 'native' }),
      execute,
      close: async () => {},
    }),
    withSession: async (_scope, operation) => operation({ id: 'project', name: 'Fixture', dir }),
    changed,
  });
  const scope = { workspaceId: 'project', agent: 'claude' as const, sessionId: 'native' };
  try {
    const preview = await service.preview(scope, { action: 'rewind-files', pointId: 'point', revision });
    expect(execute).not.toHaveBeenCalled();
    expect(preview.files).toEqual(['notes.txt']);
    await expect(service.execute({ ...scope, sessionId: 'other' }, preview.token)).rejects.toThrow();
    expect((await service.execute(scope, preview.token)).status).toBe('completed');
    await service.execute(scope, preview.token);
    expect(execute).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    const newer = await service.preview(scope, { action: 'rewind-files', pointId: 'point', revision });
    revision = 'b'.repeat(64);
    await expect(service.execute(scope, newer.token)).rejects.toThrow('变化');
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('文件在预览后被外部改动或原生候选不属于此会话时拒绝，不允许任意路径覆盖', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentdeck-rewind-race-')),
    file = path.join(dir, 'notes.txt');
  await writeFile(file, 'current');
  const execute = vi.fn(async () => ({ status: 'completed' as const, message: 'done' }));
  const service = createNativeActionsService({
    open: async () => ({
      read: async () => ({ revision: 'a'.repeat(64), candidates: [{ id: 'point', label: '输入前' }] }),
      inspect: async () => ({ files: [file], signature: 'native' }),
      execute,
      close: async () => {},
    }),
    withSession: async (_scope, operation) => operation({ id: 'project', name: 'Fixture', dir }),
    changed: async () => {},
  });
  const scope = { workspaceId: 'project', agent: 'claude' as const, sessionId: 'native' };
  try {
    await expect(
      service.preview(scope, { action: 'rewind-files', pointId: 'foreign', revision: 'a'.repeat(64) }),
    ).rejects.toThrow();
    const preview = await service.preview(scope, {
      action: 'rewind-files',
      pointId: 'point',
      revision: 'a'.repeat(64),
    });
    await writeFile(file, 'external');
    await expect(service.execute(scope, preview.token)).rejects.toThrow('变化');
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('原生执行结果未知与实例刷新失败保留同一回执，过期预览不会执行', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentdeck-rewind-receipt-'));
  const native = vi.fn(async () => {
    throw new Error('native failure');
  });
  const changed = vi.fn(async () => {});
  const service = createNativeActionsService({
    open: async () => ({
      read: async () => ({ revision: 'a'.repeat(64), candidates: [{ id: 'point', label: '输入前' }] }),
      inspect: async () => ({ files: [], signature: 'native' }),
      execute: native,
      close: async () => {},
    }),
    withSession: async (_scope, operation) => operation({ id: 'project', name: 'Fixture', dir }),
    changed,
  });
  const scope = { workspaceId: 'project', agent: 'claude' as const, sessionId: 'native' };
  const input = { action: 'rewind-files' as const, pointId: 'point', revision: 'a'.repeat(64) };
  try {
    const preview = await service.preview(scope, input);
    const results = await Promise.all([service.execute(scope, preview.token), service.execute(scope, preview.token)]);
    expect(results.map((result) => result.status)).toEqual(['unknown', 'unknown']);
    expect(native).toHaveBeenCalledOnce();
    changed.mockRejectedValueOnce(new Error('refresh failure'));
    const newer = await service.preview(scope, input);
    expect((await service.execute(scope, newer.token)).status).toBe('partial');
    const expired = await service.preview(scope, input);
    vi.spyOn(Date, 'now').mockReturnValue(expired.expiresAt + 1);
    await expect(service.execute(scope, expired.token)).rejects.toThrow('过期');
    expect(native).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});

it('预览拒绝跨工作区、大文件、错误操作类型，缺失文件也参与变更核对', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentdeck-rewind-paths-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'agentdeck-rewind-outside-'));
  let files = [path.join(outside, 'outside.txt')];
  const native = vi.fn(async () => ({ status: 'completed' as const, message: 'done' }));
  const service = createNativeActionsService({
    open: async () => ({
      read: async () => ({ revision: 'a'.repeat(64), candidates: [{ id: 'point', label: '输入前' }] }),
      inspect: async () => ({ files, signature: 'native' }),
      execute: native,
      close: async () => {},
    }),
    withSession: async (_scope, operation) => operation({ id: 'project', name: 'Fixture', dir }),
    changed: async () => {},
  });
  const scope = { workspaceId: 'project', agent: 'claude' as const, sessionId: 'native' };
  const input = { action: 'rewind-files' as const, pointId: 'point', revision: 'a'.repeat(64) };
  try {
    await expect(service.preview(scope, input)).rejects.toThrow('之外');
    await expect(service.preview(scope, { ...input, action: 'revert-history' })).rejects.toThrow('类型');
    files = [path.join(dir, 'large.txt')];
    await writeFile(files[0]!, Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(service.preview(scope, input)).rejects.toThrow();
    files = [path.join(dir, 'missing.txt')];
    const preview = await service.preview(scope, input);
    await writeFile(files[0]!, 'new');
    await expect(service.execute(scope, preview.token)).rejects.toThrow('变化');
    expect(native).not.toHaveBeenCalled();
    await expect(service.catalog({ ...scope, agent: 'antigravity' })).rejects.toThrow('没有');
    await expect(service.catalog({ ...scope, agent: 'fixture-new-cli' as AgentKind })).rejects.toThrow('没有');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it('并发预览总数有界，过期释放容量，Codex空历史不提供回退按钮', async () => {
  let candidates = [{ id: 'point', label: '回退位置' }];
  let files: string[] = [];
  const service = createNativeActionsService({
    open: async () => ({
      read: async () => ({ revision: 'a'.repeat(64), candidates }),
      inspect: async () => ({ files, removesTurns: 1, signature: 'native' }),
      execute: async () => ({ status: 'completed', message: 'done' }),
      close: async () => {},
    }),
    withSession: async (_scope, operation) => operation({ id: 'project', name: 'Fixture', dir: process.cwd() }),
    changed: async () => {},
  });
  const scope = { workspaceId: 'project', agent: 'codex' as const, sessionId: 'native' };
  const input = { action: 'revert-history' as const, pointId: 'point', revision: 'a'.repeat(64) };
  expect((await service.catalog(scope)).available).toBe(true);
  const results = await Promise.allSettled(Array.from({ length: 130 }, () => service.preview(scope, input)));
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(128);
  await expect(service.preview(scope, input)).rejects.toThrow('上限');
  const first = results.find((item) => item.status === 'fulfilled')!;
  vi.spyOn(Date, 'now').mockReturnValue(first.value.expiresAt + 1000);
  try {
    expect((await service.preview(scope, input)).notice).toContain('历史');
    candidates = [];
    expect((await service.catalog(scope)).available).toBe(false);
    candidates = [{ id: 'point', label: '位置' }];
    files = Array.from({ length: 129 }, () => 'invalid');
    await expect(service.preview(scope, input)).rejects.toThrow('过多');
    files = ['relative-file'];
    await expect(service.preview(scope, input)).rejects.toThrow('完整路径');
  } finally {
    vi.restoreAllMocks();
  }
});
