import { RESOURCE_LIMITS, SSH_CONSOLE_LIMITS, type SlurmSnapshot } from '@agentdeck/shared/ssh';
import type { SshPool } from '../ssh/pool';
import type { ConsoleAccess } from './access';
import { ResourceCache } from './cache';
import { runConsoleCommand } from './command';
import { SLURM_COMMAND, SLURM_LIMITS, SlurmQueryError, slurmResult } from './slurm-command';
import { parseSlurmOutput, slurmFailure } from './slurm-parse';

const timing = {
  ...RESOURCE_LIMITS,
  intervalMs: SSH_CONSOLE_LIMITS.refreshMs,
  timeoutMs: SLURM_LIMITS.timeoutMs,
  staleMs: SLURM_LIMITS.timeoutMs * 2,
};
const failure = (error: unknown): SlurmSnapshot =>
  error instanceof SlurmQueryError
    ? slurmFailure(error.status, error.message)
    : slurmFailure('error', 'Slurm 查询未完成，请检查 SSH 连接后重试');

/** 只读查询当前登录账号的 squeue；按服务器缓存，连接或凭据代次变化即失效。 */
export function createConsoleSlurm(pool: SshPool, access: ConsoleAccess) {
  let jobs = new ResourceCache<SlurmSnapshot>(32);
  return {
    read(this: void, serverId: string, signal?: AbortSignal): Promise<SlurmSnapshot> {
      return (async () => {
        const lease = await access.capture(serverId, signal);
        try {
          const key = JSON.stringify([lease.target.alias, lease.guard.generation, lease.guard.cacheKey]);
          const reading = await jobs.get(
            key,
            async (_previous, abort) => {
              try {
                const result = await runConsoleCommand(pool, lease, {
                  command: SLURM_COMMAND,
                  signal: abort,
                  timeoutMs: SLURM_LIMITS.timeoutMs,
                  outputCap: SLURM_LIMITS.outputBytes,
                });
                const warning = slurmResult(result) === 'warning';
                return parseSlurmOutput(result.stdout, Date.now(), warning);
              } catch (error) {
                abort.throwIfAborted();
                return failure(error);
              }
            },
            timing,
          );
          await lease.recheck();
          return structuredClone(reading.data ?? failure(reading.message));
        } finally {
          lease.close();
        }
      })();
    },
    dispose() {
      jobs.dispose();
      jobs = new ResourceCache<SlurmSnapshot>(32);
    },
  };
}
export type ConsoleSlurm = ReturnType<typeof createConsoleSlurm>;
