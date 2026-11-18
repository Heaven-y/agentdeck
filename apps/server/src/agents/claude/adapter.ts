// Claude 适配器：同一会话复用长驻运行时，空闲超时后回收。
import type { TurnHandle, TurnRunner } from '../contracts';
import { ClaudeRuntime, PERMISSION_TIMEOUT_MS, type ClaudeTurnInput } from './run/runtime';
import type { McpRuntimeRegistry } from '../../native-management/mcp/mcp-runtime';
import { SessionError } from '../errors';

export type { PermissionAnswer, TurnHandle } from '../contracts';
export type { QueryFn } from './run/query';
export type { ClaudeTurnInput } from './run/runtime';
export { PERMISSION_TIMEOUT_MS };

/** 没有新轮次时保留原生进程的时间；超过后关闭。 */
export const CLAUDE_IDLE_TIMEOUT_MS = 5 * 60_000;

/** 单轮调用：创建运行时、跑完即关闭，用于能力探测与一次性操作。 */
export function runClaudeTurn(input: ClaudeTurnInput): TurnHandle {
  const runtime = new ClaudeRuntime(input);
  const handle = runtime.run(input);
  return {
    interrupt: () => handle.interrupt(),
    done: handle.done.then(() => runtime.close()),
  };
}

type Entry = { runtime: ClaudeRuntime; key: string; timer?: NodeJS.Timeout };

/**
 * 按工作区、原生会话与模型配置复用运行时。
 * 模型或推理强度改变时创建新运行时，避免沿用旧进程的启动参数。
 */
export function createClaudeRunner(
  options: { idleMs?: number; env?: NodeJS.ProcessEnv; mcpRegistry?: McpRuntimeRegistry } = {},
): TurnRunner {
  const idleMs = options.idleMs ?? CLAUDE_IDLE_TIMEOUT_MS;
  const runtimes = new Map<string, Entry>();
  const keyOf = (input: ClaudeTurnInput) =>
    JSON.stringify([
      input.workspace.id,
      input.projectDir ?? input.workspace.dir,
      input.workspace.dir,
      input.sessionId ?? '',
      input.model ?? '',
      input.reasoningEffort ?? '',
      input.permission?.mode ?? '',
    ]);
  const drop = async (entry: Entry) => {
    clearTimeout(entry.timer);
    if (runtimes.get(entry.key) === entry) runtimes.delete(entry.key);
    await entry.runtime.close();
  };
  const schedule = (entry: Entry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.runtime.tasks.active) schedule(entry);
      else void drop(entry);
    }, idleMs);
    entry.timer.unref?.();
  };
  const runner = ((input: ClaudeTurnInput): TurnHandle => {
    assertBackgroundChoice(input);
    let entry = runtimes.get(keyOf(input));
    if (entry && !entry.runtime.alive) {
      void drop(entry);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        runtime: new ClaudeRuntime({ ...input, env: options.env, mcpRegistry: options.mcpRegistry }),
        key: keyOf(input),
      };
      runtimes.set(entry.key, entry);
    }
    clearTimeout(entry.timer);
    const current = entry;
    const handle = current.runtime.run(input);
    return {
      interrupt: () => handle.interrupt(),
      done: handle.done.then(async () => {
        if (!current.runtime.alive) {
          await drop(current);
          return;
        }
        // 新会话在首轮才拿到原生 id，收尾时改登记，后续轮次才能复用同一进程。
        const learned = keyOf({ ...input, sessionId: current.runtime.sessionId ?? input.sessionId });
        if (learned !== current.key && !runtimes.has(learned)) {
          runtimes.delete(current.key);
          current.key = learned;
          runtimes.set(learned, current);
        }
        schedule(current);
      }),
    };
  }) as TurnRunner;
  function assertBackgroundChoice(input: ClaudeTurnInput): void {
    if (!input.sessionId) return;
    if (
      [...runtimes.values()].some(
        (entry) =>
          entry.runtime.sessionId === input.sessionId && entry.runtime.tasks.active && entry.key !== keyOf(input),
      )
    )
      throw new SessionError(409, 'runtime_busy', '此会话的后台任务仍在运行，请先完成或停止后再更换运行设置。');
  }
  runner.hasBackground = () => [...runtimes.values()].some((entry) => entry.runtime.tasks.active);
  runner.runtimeControl = (id) =>
    [...runtimes.values()].find((entry) => entry.runtime.sessionId === id)?.runtime.runtimeControl();
  runner.dispose = async () => {
    const entries = [...runtimes.values()];
    runtimes.clear();
    await Promise.all(entries.map((entry) => drop(entry)));
  };
  return runner;
}
