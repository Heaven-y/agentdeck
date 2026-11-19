import type { AgentEvent } from '@agentdeck/shared/conversation';
import { stripVTControlCharacters } from 'node:util';

type DiagnosticEvent = Extract<AgentEvent, { type: 'error' | 'activity' }>;

export const ANTIGRAVITY_PERMISSION_NOTICE =
  'Antigravity 拒绝了需要确认的工具操作；无交互模式无法完成这次确认。请检查原生权限（permissions）规则，本应用不会自动放行。';

function serviceDiagnostic(line: string, source: 'run' | 'tool'): DiagnosticEvent | undefined {
  if (source === 'run' && rateLimitFailure(line))
    return {
      type: 'error',
      message: 'Antigravity 的模型服务请求受限（HTTP 429），本轮未完成。请稍后重试。',
    };
  if (/\b(?:error|http|status(?:[_ ]code)?)[\s:="']*524\b/i.test(line))
    return {
      type: 'error',
      message: 'Antigravity 的模型服务响应超时（HTTP 524），本轮未完成。请稍后重试或检查原生模型服务。',
    };
  if (source === 'run' && /\b(?:error|http|status(?:[_ ]code)?)[\s:="']*500\b/i.test(line))
    return {
      type: 'error',
      message: 'Antigravity 的模型服务返回内部错误（HTTP 500），本轮未完成。请检查当前模型服务或稍后重试。',
    };
  if (
    /\b(?:error|http|status(?:[_ ]code)?)[\s:="']*503\b|\bstatus\s*[:=]\s*UNAVAILABLE\b|"status"\s*:\s*"UNAVAILABLE"/i.test(
      line,
    )
  )
    return {
      type: 'error',
      message: 'Antigravity 的模型服务暂时不可用（503 / UNAVAILABLE），请稍后重试或检查原生模型服务配置。',
    };
  return undefined;
}

/** 网关或模型服务的临时故障：原生常自行重试，出现它不代表本轮没有产出。 */
export const serviceFailure = (value: string): boolean =>
  /\b(?:error|http|status(?:[_ ]code)?)[\s:="']*(?:429|500|503|524)\b/i.test(stripVTControlCharacters(value));

export const rateLimitFailure = (value: string): boolean =>
  /\b(?:error|http|status(?:[_ ]code)?)[\s:="']*429\b/i.test(stripVTControlCharacters(value));

function agyShortError(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const data = parsed as Record<string, unknown>;
    return Object.keys(data).length === 1 && typeof data.short_error === 'string' ? data.short_error.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 仅已确认的独立 429 或原生限流格式可作为恢复证据；未知附文保留失败。 */
export function rateLimitOnlyFailure(value: string): boolean {
  let plain = stripVTControlCharacters(value).trim();
  if (!rateLimitFailure(plain)) return false;
  for (let depth = 0; depth < 4; depth++) {
    if (/^(?:error|http|status(?:[_ ]code)?)[\s:="']*429\.?$/i.test(plain)) return true;
    if (
      /^api\s+error\s*\(attempt\s+\d+\)\s*:\s*error[\s:="']*429\s*,\s*message\s*:\s*upstream\s+rate\s+limit\s+exceeded\s*,\s*please\s+retry\s+later\.?$/i.test(
        plain,
      )
    )
      return true;
    const outer = /^error\s*:\s*/i.exec(plain);
    if (outer) {
      plain = plain.slice(outer[0].length).trim();
      continue;
    }
    const agy = /^AGY_ERROR\s*:\s*/i.exec(plain);
    if (!agy) return false;
    const shortError = agyShortError(plain.slice(agy[0].length));
    if (!shortError) return false;
    plain = shortError;
  }
  return false;
}

/** 混合故障中的其他状态码只输出已脱敏的 HTTP 数字。 */
export function additionalServiceDiagnostic(value: string): Extract<AgentEvent, { type: 'error' }> {
  const code = value.match(/\b(?:error|http(?:\/\d(?:\.\d)?)?|status(?:[_ ]code)?|code)[\s:="']*([45]\d{2})\b/i)?.[1];
  return {
    type: 'error',
    message: code
      ? `Antigravity 的模型服务返回 HTTP ${code}，本轮未完成。请检查当前模型服务或稍后重试。`
      : 'Antigravity 的模型服务还返回其他错误，本轮未完成。请检查当前模型服务或稍后重试。',
  };
}

/** 只识别明确的原生错误或模式变化；固定文案不拼接诊断中的 URL、参数或凭据。 */
export function antigravityDiagnostic(value: string, source: 'run' | 'tool' = 'run'): DiagnosticEvent | undefined {
  const line = stripVTControlCharacters(value).trim();
  if (/^(?:info|debug|trace)\s*:|^I\d{4}\s/i.test(line)) return undefined;
  if (
    /(?:--mode\s+auto|auto\s+mode|mode\s+auto)/i.test(line) &&
    /not available|unavailable|not supported|unsupported/i.test(line)
  ) {
    const fallback = /continuing in the default mode|fall(?:ing)? back|fallback/i.test(line);
    const reason = /sandbox/i.test(line) ? '当前环境的终端沙箱不可用' : '当前账号或运行环境不支持此模式';
    if (!fallback)
      return { type: 'error', message: `Antigravity 的 auto 模式不可用：${reason}。请检查原生权限与沙箱支持。` };
    return {
      type: 'activity',
      id: 'agy-permission-mode',
      name: '权限模式已回退',
      status: 'completed',
      output: `Antigravity 的 auto 模式不可用：${reason}。原生 CLI 已回退到默认权限模式，需要确认的工具仍可能被拒绝。请检查原生权限与沙箱支持。`,
    };
  }
  return failureDiagnostic(line, source);
}

function failureDiagnostic(line: string, source: 'run' | 'tool'): DiagnosticEvent | undefined {
  // 只认生成终态的明确拒绝，不将后台探测的 403 视为回合失败。
  if (source === 'run' && /\bUser location is not supported for the API use\b/i.test(line))
    return { type: 'error', message: 'Antigravity 官方服务不支持当前访问地区。请核对网络出口与 Google 的可用地区。' };
  if (
    /\b(?:unauthenticated|unauthorized|authentication required|authentication failed|login required|invalid api[ _-]?key|expired (?:credentials|token)|missing (?:credentials|api[ _-]?key))\b/i.test(
      line,
    )
  )
    return {
      type: 'error',
      message: 'Antigravity 认证失败。官方账号可在模型设置中重新登录；Gemini 模式请检查凭据。',
    };
  const service = serviceDiagnostic(line, source);
  if (service) return service;
  if (/soft[-_\s]?den(?:ied|y)|\b(?:user denied permission|approval (?:was )?denied)\b/i.test(line))
    return { type: 'error', message: ANTIGRAVITY_PERMISSION_NOTICE };
  return undefined;
}
