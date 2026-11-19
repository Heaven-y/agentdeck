import { ANTIGRAVITY_PROXY_VARIABLES } from '@agentdeck/shared/settings';
import type { LaunchVariable } from '../../common/configuration/contracts';

const proxyLabels = {
  HTTPS_PROXY: 'HTTPS 请求代理',
  HTTP_PROXY: 'HTTP 请求代理',
  NO_PROXY: '代理绕过名单',
} as const;
export const launchVariables: LaunchVariable[] = [
  { name: 'GEMINI_API_KEY', label: 'Gemini API 密钥', sensitive: true },
  { name: 'GOOGLE_GEMINI_BASE_URL', label: 'Gemini API 地址', sensitive: false },
  { name: 'AGY_ADC_AUTH', label: '使用 ADC 认证（true/false）', sensitive: false },
  { name: 'GOOGLE_CLOUD_QUOTA_PROJECT', label: 'ADC 配额项目', sensitive: false },
  { name: 'GOOGLE_CLOUD_LOCATION', label: 'ADC 区域', sensitive: false },
  ...ANTIGRAVITY_PROXY_VARIABLES.map((name) => ({ name, label: proxyLabels[name], sensitive: name !== 'NO_PROXY' })),
];

export function validAntigravityProxy(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}
