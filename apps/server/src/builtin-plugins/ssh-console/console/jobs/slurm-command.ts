import type { ExecResult } from '../../ssh/transport/exec';

export const SLURM_LIMITS = { timeoutMs: 8000, outputBytes: 512 * 1024, lines: 200 } as const;
export const SLURM_COMMAND =
  'LC_ALL=C squeue --noheader --user="$(id -un)" --format="%.18i %.9P %.24j %.8u %.2t %.10M %.6D %R"';

export class SlurmQueryError extends Error {
  constructor(
    readonly status: 'unavailable' | 'error',
    message: string,
  ) {
    super(message);
  }
}

/**
 * 把 squeue 的执行结果分成可用与失败两类。
 * 成功时只回报 stderr 是否非空——成功也可能带警告，但原始诊断不出后端。
 */
export function slurmResult(result: ExecResult): 'ok' | 'warning' {
  if (result.timedOut) throw new SlurmQueryError('error', 'Slurm 查询超时（8 秒），请手动重试');
  if (result.truncated) throw new SlurmQueryError('error', 'Slurm 输出超过 512 KiB，已拒绝不完整结果');
  if (result.exitCode === 127) throw new SlurmQueryError('unavailable', '未找到 squeue，请确认服务器已安装 Slurm');
  if (result.exitCode !== 0) throw new SlurmQueryError('error', 'Slurm 查询失败，请检查账号权限或控制器状态');
  return result.stderr.length > 0 ? 'warning' : 'ok';
}
