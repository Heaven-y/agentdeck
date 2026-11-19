import type { AntigravityOfficialUsage } from '@agentdeck/shared/conversation';
import { z } from 'zod';
import { resolveLocalCommand } from '../../../platform/process/executable';
import { ProcessError, runProcess, type ProcessResult } from '../../../platform/process/run';
import { SessionError } from '../../errors';
import { withAntigravityDiscoveryProfile } from '../models/discovery-profile';
import { readAntigravityConnection } from '../models/model-catalog';

type Options = { env?: NodeJS.ProcessEnv; signal?: AbortSignal; homeDir?: string };
const timeoutMs = 35_000;
const unavailable = () =>
  new SessionError(
    503,
    'antigravity_official_usage_unavailable',
    '暂时无法读取 Antigravity 官方额度，请确认 CLI 已安装并登录官方账号。',
  );

const label = z.string().trim().min(1);
const bucket = z.object({
  id: label,
  name: label,
  window: label.optional().catch(undefined),
  remaining_fraction: z.number().min(0).max(1).optional().catch(undefined),
  reset_time: z.iso.datetime({ offset: true }).optional().catch(undefined),
});
const envelope = z.object({
  status: z.literal('SUCCESS'),
  command: z.object({
    name: z.literal('usage'),
    data: z.object({ groups: z.array(z.object({ name: label, buckets: z.array(bucket) })) }),
  }),
});

function usageGroups(result: ProcessResult): AntigravityOfficialUsage['groups'] {
  if (result.exitCode !== 0) throw unavailable();
  const { command } = envelope.parse(JSON.parse(result.stdout.toString('utf8')));
  return command.data.groups.map(({ name, buckets }) => ({
    name,
    buckets: buckets.map(({ id, name, window, remaining_fraction, reset_time }) => ({
      id,
      name,
      ...(window === undefined ? {} : { window }),
      ...(remaining_fraction === undefined ? {} : { remainingFraction: remaining_fraction }),
      ...(reset_time === undefined ? {} : { resetAt: reset_time }),
    })),
  }));
}

function supportsReadOnlyUsage(result: ProcessResult): boolean {
  if (result.exitCode !== 0) return false;
  const text = result.stdout.toString('utf8').trim() || result.stderr.toString('utf8').trim();
  const version = text.match(
    /^(?:(?:agy(?:\s+version)?|Antigravity(?: CLI)?)\s+)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[a-z0-9-]+(?:\.[a-z0-9-]+)*)?$/i,
  );
  if (!version) return false;
  const [major, minor, patch] = [Number(version[1]), Number(version[2]), Number(version[3])];
  return (
    [major, minor, patch].every(Number.isSafeInteger) &&
    (major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11))))
  );
}

async function assertAccount(options: Options) {
  const connection = await readAntigravityConnection(options);
  if (connection === 'account') return;
  const message =
    connection === 'gemini'
      ? 'Gemini API Key 或 ADC 模式不支持查询 Antigravity 官方额度。'
      : '无法确认 Antigravity 使用官方账号模式，未查询官方额度。';
  throw new SessionError(409, 'antigravity_official_usage_account_required', message);
}

function accountEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // 不继承 Gemini/ADC 认证或原生配置覆盖。尤其不能让 AGY_DISABLE_SLASH_COMMANDS 将 /usage 降级为生成。
  const overridden =
    /^(?:(?:AGY|ANTIGRAVITY|GEMINI|GOOGLE|GCLOUD|CLOUDSDK)_|XDG_(?:DATA|STATE)_HOME$|NODE_(?:OPTIONS|PATH)$)/i;
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !overridden.test(name))),
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  };
}

function usageFailure(error: unknown, deadline: AbortSignal, request?: AbortSignal): SessionError {
  if (request?.aborted)
    return new SessionError(499, 'antigravity_official_usage_cancelled', 'Antigravity 官方额度查询已取消。');
  if (deadline.aborted || (error instanceof ProcessError && error.code === 'timeout'))
    return new SessionError(504, 'antigravity_official_usage_timeout', 'Antigravity 官方额度查询超时，已停止。');
  return error instanceof SessionError ? error : unavailable();
}

/** 只接受原生账号命令的结构化成功结果，与生成请求或回合 token 无关。 */
export async function readAntigravityOfficialUsage(options: Options = {}): Promise<AntigravityOfficialUsage> {
  const env = options.env ?? process.env;
  const settings = { env, homeDir: options.homeDir };
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    signal.throwIfAborted();
    await assertAccount(settings);
    const cli = resolveLocalCommand('agy', env);
    const groups = await withAntigravityDiscoveryProfile(
      {},
      accountEnvironment(env),
      async ({ root, env: isolated }) => {
        const run = (args: string[], timeoutMs: number, outputCap: number) => {
          signal.throwIfAborted();
          return runProcess(cli.command, [...cli.args, ...args], {
            cwd: root,
            env: isolated,
            timeoutMs,
            outputCap,
            signal,
          });
        };
        if (!supportsReadOnlyUsage(await run(['--version'], 5_000, 16 * 1024)))
          throw new SessionError(
            503,
            'antigravity_official_usage_version_unsupported',
            'Antigravity 官方额度查询需要 1.1.11 或更新的稳定版 CLI。',
          );
        await assertAccount(settings);
        return usageGroups(await run(['-p', '/usage', '--output-format', 'json'], timeoutMs, 256 * 1024));
      },
    );
    // 不返回在途切换连接模式后得到的账号额度。
    await assertAccount(settings);
    signal.throwIfAborted();
    return { checkedAt: Date.now(), groups };
  } catch (error) {
    throw usageFailure(error, deadline, options.signal);
  }
}
