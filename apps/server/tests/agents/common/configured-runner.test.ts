import { expect, it, vi } from 'vitest';
import { createConfiguredRunner } from '../../../src/agents/common/configured-runner';
import type { AgentTurnInput, TurnRunner } from '../../../src/agents/contracts';
import path from 'node:path';

const input = (sessionId?: string): AgentTurnInput => ({
  workspace: { id: 'project', name: '示例', dir: path.resolve('fixtures', 'project') },
  sessionId,
  text: '本地夹具',
  emit: vi.fn(),
  requestPermission: vi.fn(),
});
it('父回合结束后后台任务阻止空闲回收和重启，权限更改不能杀死后台实例', async () => {
  vi.useFakeTimers();
  let active = true;
  const dispose = vi.fn(async () => {}),
    native = vi.fn(() => ({ done: Promise.resolve(), interrupt: async () => {} })) as unknown as TurnRunner;
  native.dispose = dispose;
  native.hasBackground = () => active;
  const runner = createConfiguredRunner({ idleMs: 100, environment: async () => ({}), create: () => native });
  try {
    await runner(input('native')).done;
    await vi.advanceTimersByTimeAsync(201);
    expect(dispose).not.toHaveBeenCalled();
    await expect(runner.restart()).rejects.toThrow();
    const next = { ...input('native'), permission: { agent: 'claude' as const, mode: 'plan' as const } };
    await runner(next).done;
    expect(dispose).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledOnce();
    active = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    await runner.dispose?.();
    vi.useRealTimers();
  }
});
it('新进程读取环境，已有会话保持快照，显式重启后采用新环境', async () => {
  let key = 'first';
  const applied: string[] = [];
  const dispose = vi.fn(async () => undefined);
  const runner = createConfiguredRunner({
    environment: async () => ({ API_KEY: key }),
    create: (env) => {
      applied.push(env.API_KEY!);
      const native: TurnRunner = (value) => {
        value.emit({
          type: 'session',
          sessionId: value.sessionId ?? 'learned',
          model: 'fixture',
          cwd: value.workspace.dir,
        });
        return { done: Promise.resolve(), interrupt: async () => undefined };
      };
      native.dispose = dispose;
      return native;
    },
  });
  await runner(input()).done;
  key = 'second';
  await runner(input('learned')).done;
  expect(applied).toEqual(['first']);
  await runner.restart();
  await runner(input('learned')).done;
  expect(applied).toEqual(['first', 'second']);
  expect(dispose).toHaveBeenCalledTimes(1);
  await runner.dispose?.();
});
it('环境准备中停止不投递正文，准备和运行期间不允许重启', async () => {
  let resolve!: (env: NodeJS.ProcessEnv) => void;
  const create = vi.fn(() => vi.fn() as TurnRunner);
  const runner = createConfiguredRunner({
    environment: () =>
      new Promise((done) => {
        resolve = done;
      }),
    create,
  });
  const handle = runner(input());
  await expect(runner.restart()).rejects.toThrow();
  const stopped = handle.interrupt();
  resolve({});
  await stopped;
  await handle.done;
  expect(create).not.toHaveBeenCalled();
  await runner.dispose?.();
});

it('代理版本变更后同一个原生会话的下一轮使用新代理', async () => {
  let generation = 0;
  const proxies = ['http://first-proxy', 'http://next-proxy'];
  const create = vi.fn<(env: NodeJS.ProcessEnv) => TurnRunner>(() => () => ({
    done: Promise.resolve(),
    interrupt: async () => undefined,
  }));
  const runner = createConfiguredRunner({
    environment: async () => ({ HTTPS_PROXY: proxies[generation] }),
    environmentVersion: () => generation,
    create,
  });
  try {
    await runner(input('native')).done;
    await runner(input('native')).done;
    expect(create).toHaveBeenCalledOnce();
    generation++;
    await runner(input('native')).done;
    expect(create.mock.calls.map(([env]) => env.HTTPS_PROXY)).toEqual(proxies);
  } finally {
    await runner.dispose?.();
  }
});

it('保存配置后新会话立即使用新环境，已有会话继续持有原快照', async () => {
  let current = 'before-save';
  let created = 0;
  const used: string[] = [];
  const runner = createConfiguredRunner({
    environment: async () => ({ API_KEY: current }),
    create: (env) => {
      const sessionId = `native-${++created}`;
      return (value) => {
        used.push(env.API_KEY!);
        value.emit({ type: 'session', sessionId, cwd: value.workspace.dir, model: 'fixture-model' });
        return { done: Promise.resolve(), interrupt: async () => undefined };
      };
    },
  });
  try {
    await runner(input()).done;
    current = 'after-save';
    await runner(input()).done;
    await runner(input('native-1')).done;
    expect(used).toEqual(['before-save', 'after-save', 'before-save']);
  } finally {
    await runner.dispose?.();
  }
});

it('退出不等待永不结束的interrupt才调用原生清理', async () => {
  const dispose = vi.fn(async () => undefined);
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const native: TurnRunner = () => {
    started();
    return { done: new Promise(() => undefined), interrupt: () => new Promise(() => undefined) };
  };
  native.dispose = dispose;
  const runner = createConfiguredRunner({ environment: async () => ({}), create: () => native });
  runner(input('running'));
  await running;
  await runner.dispose?.();
  expect(dispose).toHaveBeenCalledOnce();
});

it('并发完成启动环境解析时仍限制32个原生实例，重启后可重新分配', async () => {
  let release!: (env: NodeJS.ProcessEnv) => void;
  const environment = new Promise<NodeJS.ProcessEnv>((resolve) => {
    release = resolve;
  });
  const executed: string[] = [];
  const runner = createConfiguredRunner({
    environment: () => environment,
    create: () => (value) => {
      executed.push(value.sessionId!);
      return { done: Promise.resolve(), interrupt: async () => undefined };
    },
  });
  const inputs = Array.from({ length: 33 }, (_, index) => input(`session-${index}`));
  try {
    const handles = inputs.map(runner);
    release({});
    await Promise.all(handles.map((handle) => handle.done));
    expect(executed).toHaveLength(32);
    expect(inputs[32]!.emit).toHaveBeenCalledWith({ type: 'turn_end', isError: true });
    await runner.restart();
    await runner(input('after-restart')).done;
    expect(executed.at(-1)).toBe('after-restart');
  } finally {
    await runner.dispose?.();
  }
});

it('权限变化先回收旧实例，切回原生默认也重新启动且保留同一原生会话', async () => {
  let started = 0;
  const closed: number[] = [];
  const history: string[] = [];
  const runner = createConfiguredRunner({
    environment: async () => ({}),
    create: () => {
      const id = ++started;
      const native: TurnRunner = (value) => {
        history.push(value.sessionId!);
        return { done: Promise.resolve(), interrupt: async () => undefined };
      };
      native.dispose = async () => {
        closed.push(id);
      };
      return native;
    },
  });
  try {
    await runner({ ...input('same-session'), permission: { agent: 'codex', mode: 'full-access' } }).done;
    await runner(input('same-session')).done;
    expect(closed).toEqual([1]);
    expect(started).toBe(2);
    await runner(input('same-session')).done;
    expect(started).toBe(2);
    expect(history).toEqual(['same-session', 'same-session', 'same-session']);
  } finally {
    await runner.dispose?.();
  }
});
it('项目根变更但原生 cwd 不变时创建新实例，保留原项目根身份', async () => {
  const create = vi.fn((): TurnRunner => () => ({ done: Promise.resolve(), interrupt: async () => {} }));
  const runner = createConfiguredRunner({ environment: async () => ({}), create });
  const current = input('same-session');
  try {
    await runner({ ...current, projectDir: path.dirname(current.workspace.dir) }).done;
    await runner({ ...current, projectDir: current.workspace.dir }).done;
    expect(create).toHaveBeenCalledTimes(2);
    await runner({ ...current, projectDir: current.workspace.dir }).done;
    expect(create).toHaveBeenCalledTimes(2);
  } finally {
    await runner.dispose?.();
  }
});
