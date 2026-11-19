import type { OfficialUsage } from '@agentdeck/shared/conversation';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionError } from '../errors';
import { CodexClient } from './run/client';
import { type CodexRuntimeOptions, type RecordValue, record, text } from './run/types';

export type AccountReader = Pick<CodexClient, 'request'>;

function isNativeOpenAI(config: RecordValue, env: NodeJS.ProcessEnv) {
  const provider = config.model_provider;
  if (provider != null && provider !== 'openai') return false;
  // 原生会回显 ChatGPT 默认地址；只把其他地址视为覆盖，不把自定义网关当成官方额度。
  const chatgptUrl = text(config.chatgpt_base_url).trim().replace(/\/$/, '');
  if (chatgptUrl && chatgptUrl !== 'https://chatgpt.com/backend-api') return false;
  // 自定义网关或可能覆盖认证的 Key 与 ChatGPT 用量无关，不向账号端点发送请求。
  return ![config.openai_base_url, env.OPENAI_BASE_URL, env.OPENAI_API_KEY, env.CODEX_API_KEY].some((value) =>
    text(value).trim(),
  );
}

/** 不读取凭据文件，不刷新登录，不把账号响应写进目录缓存。只向工作台报告已核实的模式。 */
export async function readCodexAccountScope(client: AccountReader, config: RecordValue, env: NodeJS.ProcessEnv) {
  if (!isNativeOpenAI(config, env)) return;
  const result = await Promise.race([
    client.request('account/read', { refreshToken: false }).catch(() => undefined),
    delay(2_000, undefined, { ref: false }),
  ]);
  return result?.requiresOpenaiAuth === true && record(result.account).type === 'chatgpt' ? true : undefined;
}

function knownConfig(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function resetAt(value: unknown) {
  const date = typeof value === 'number' && value > 0 ? new Date(value * 1_000) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function bucket(id: string, kind: 'primary' | 'secondary', value: unknown) {
  if (!knownConfig(value)) return [];
  const percent = value.usedPercent;
  const minutes = value.windowDurationMins;
  const remainingFraction =
    typeof percent === 'number' && percent >= 0 && percent <= 100 ? (100 - percent) / 100 : undefined;
  return [
    {
      id: `${id}:${kind}`,
      name: kind === 'primary' ? '主要额度窗口' : '次要额度窗口',
      window:
        typeof minutes === 'number' && Number.isSafeInteger(minutes) && minutes > 0 ? `${minutes} 分钟` : undefined,
      remainingFraction,
      resetAt: resetAt(value.resetsAt),
    },
  ];
}

function usageReport(result: RecordValue): OfficialUsage {
  const multi = Object.entries(record(result.rateLimitsByLimitId));
  const entries = multi.length ? multi : [['codex', result.rateLimits] as const];
  const groups = entries.slice(0, 64).flatMap(([key, raw]) => {
    if (!knownConfig(raw)) return [];
    const id = (text(raw.limitId) || key).slice(0, 100);
    const buckets = [...bucket(id, 'primary', raw.primary), ...bucket(id, 'secondary', raw.secondary)];
    return [{ name: text(raw.limitName).trim().slice(0, 120) || (id === 'codex' ? 'Codex' : id), buckets }];
  });
  return { checkedAt: Date.now(), groups };
}

export async function fetchCodexOfficialUsage(client: AccountReader, dir: string, env: NodeJS.ProcessEnv) {
  const { config } = await client.request('config/read', { cwd: dir, includeLayers: false });
  if (!knownConfig(config) || !(await readCodexAccountScope(client, config, env)))
    throw new SessionError(
      409,
      'codex_official_usage_account_required',
      '仅已通过原生 OpenAI 登录的 ChatGPT 模式可读取官方额度。',
    );
  return usageReport(await client.request('account/rateLimits/read', {}));
}

export async function readCodexOfficialUsage(dir: string, options: CodexRuntimeOptions) {
  const deadline = AbortSignal.timeout(12_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const client = await CodexClient.start({ ...options, cwd: dir, signal });
  try {
    await client.initialize();
    const usage = await fetchCodexOfficialUsage(client, dir, { ...process.env, ...options.env });
    signal.throwIfAborted();
    return usage;
  } finally {
    await client.close();
  }
}
