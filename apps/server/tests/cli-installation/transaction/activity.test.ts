import { expect, it } from 'vitest';
import type { SessionProvider } from '../../../src/agents/contracts';
import { createCliActivity, guardSessionProvider } from '../../../src/bootstrap/cli-activity';

it('安装排斥在途原生读取，维护期间拒绝同来源新读取，其他 CLI 保持可用', async () => {
  const activity = createCliActivity();
  let release!: () => void;
  const pending = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const provider = guardSessionProvider(
    'antigravity',
    { readHistoryPage: pending } as unknown as SessionProvider,
    activity,
  );
  const reading = provider.readHistoryPage!('session', 'project', undefined);
  await expect(activity.exclusive('antigravity', async () => undefined)).rejects.toMatchObject({ code: 'agent_busy' });
  release();
  await reading;
  const installing = activity.exclusive('antigravity', pending);
  await expect(activity.run('antigravity', async () => undefined)).rejects.toMatchObject({ code: 'agent_busy' });
  await expect(activity.run('codex', async () => 'ok')).resolves.toBe('ok');
  release();
  await installing;
  await expect(activity.exclusive('antigravity', () => Promise.reject(new Error('fixture')))).rejects.toThrow(
    'fixture',
  );
  await expect(activity.run('antigravity', async () => 'ok')).resolves.toBe('ok');
});

it('按项目目录发现会话时仍占用 CLI 读取租约，阻止并发安装', async () => {
  const activity = createCliActivity();
  let started!: () => void;
  let release!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<never>((resolve) => {
    release = () => resolve([] as never);
  });
  const provider = guardSessionProvider(
    'claude',
    {
      list: async () => [],
      listProjects: async () => {
        started();
        return pending;
      },
    } as unknown as SessionProvider,
    activity,
  );

  const reading = provider.listProjects!(['project']);
  await began;
  await expect(activity.exclusive('claude', async () => undefined)).rejects.toMatchObject({ code: 'agent_busy' });
  release();
  await reading;
});
