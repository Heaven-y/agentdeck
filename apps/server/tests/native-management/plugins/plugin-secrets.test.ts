import { pluginHelp } from './plugin-help';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativePluginPrepareInput } from '@agentdeck/shared/settings';
import { createNativePluginService } from '../../../src/native-management/plugins/plugin-service';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-plugin-secrets-'));
  roots.push(root);
  const retained: NativePluginPrepareInput[] = [];
  const clone = globalThis.structuredClone;
  // 只观察测试自己的合成输入副本，验证真实任务释放引用，不增加生产测试接口。
  vi.spyOn(globalThis, 'structuredClone').mockImplementation((value) => {
    const result = clone(value);
    const input = result as NativePluginPrepareInput | undefined;
    if (input?.action === 'configure' && input.values?.token === 'synthetic-secret') retained.push(input);
    return result;
  });
  let mode = 'success',
    configured = false;
  const service = createNativePluginService({
    homeDir: root,
    env: {},
    command: () => ({ command: process.execPath, args: [] }),
    access: {
      read: (_agent, action) => action(),
      write: (_agent, _project, action) => (mode === 'busy' ? Promise.reject(new Error('busy')) : action()),
    },
    onChanged: () => {
      if (mode === 'invalidation') throw new Error('invalidation');
    },
    run: (_exe, args) => {
      let value: unknown;
      const help = pluginHelp('claude', args);
      if (help !== undefined) value = help;
      else if (args[1] === 'list')
        value = [
          {
            id: 'demo@fixture',
            scope: 'user',
            version: '1',
            enabled: true,
            hasUserConfig: true,
            installPath: path.join(root, 'plugin'),
          },
        ];
      else {
        if (args.includes('--values-stdin')) configured = true;
        value = {
          schema: { token: { type: 'string', sensitive: true } },
          inputs: { token: mode === 'preflight' ? 'external' : 'old' },
          configured: configured ? ['token'] : [],
        };
      }
      return Promise.resolve({
        stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
        stderr: Buffer.alloc(0),
        exitCode: mode === 'native-failure' && args.includes('--values-stdin') ? 1 : 0,
      });
    },
  });
  async function prepare() {
    const entry = (await service.read('claude')).entries[0]!;
    const detail = await service.detail('claude', entry.id, entry.revision);
    return service.prepare('claude', {
      action: 'configure',
      id: entry.id,
      revision: entry.revision,
      configurationRevision: detail.configurationRevision,
      values: { token: 'synthetic-secret' },
    });
  }
  return {
    service,
    retained,
    prepare,
    setMode: (value: string) => {
      mode = value;
    },
  };
}
it('配置预览后维护忙碌，失败终态及再次取消不再保留秘密', async () => {
  const f = await fixture(),
    task = await f.prepare();
  try {
    expect(f.retained[0]!.values).toEqual({ token: 'synthetic-secret' });
    f.setMode('busy');
    await expect(f.service.start('claude', { operationId: task.operationId, revision: task.revision })).rejects.toThrow(
      'busy',
    );
    expect(f.service.operation('claude', undefined, task.operationId).status).toBe('failed');
    expect(f.retained[0]!.values).toBeUndefined();
    f.service.cancel('claude', undefined, task.operationId);
    expect(f.retained[0]!.values).toBeUndefined();
  } finally {
    await f.service.dispose();
  }
});
it.each(['success', 'preflight', 'native-failure', 'invalidation'])('配置任务 %s 路径释放待写值', async (mode) => {
  const f = await fixture(),
    task = await f.prepare();
  try {
    f.setMode(mode);
    await f.service.start('claude', { operationId: task.operationId, revision: task.revision }).catch(() => undefined);
    await vi.waitFor(() =>
      expect(['succeeded', 'failed', 'unknown']).toContain(
        f.service.operation('claude', undefined, task.operationId).status,
      ),
    );
    expect(f.retained[0]!.values).toBeUndefined();
  } finally {
    await f.service.dispose();
  }
});
it('未开始配置的显式取消和预览过期都会释放待写值', async () => {
  const f = await fixture();
  try {
    const cancelled = await f.prepare();
    f.service.cancel('claude', undefined, cancelled.operationId);
    expect(f.retained[0]!.values).toBeUndefined();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const expired = await f.prepare();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(f.service.operation('claude', undefined, expired.operationId).status).toBe('failed');
    expect(f.retained[1]!.values).toBeUndefined();
  } finally {
    await f.service.dispose();
  }
});
it('宿主时钟跨过预览期限但定时器未触发时，开始拒绝也清除秘密', async () => {
  const f = await fixture();
  try {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const task = await f.prepare();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await expect(
      f.service.start('claude', { operationId: task.operationId, revision: task.revision }),
    ).rejects.toMatchObject({ code: 'plugin_expired' });
    expect(f.service.operation('claude', undefined, task.operationId).status).toBe('failed');
    expect(f.retained[0]!.values).toBeUndefined();
  } finally {
    await f.service.dispose();
  }
});
