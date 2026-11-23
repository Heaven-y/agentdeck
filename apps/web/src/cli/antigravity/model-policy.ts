import type { AntigravityConnection } from '@agentdeck/shared/conversation';

export const ANTIGRAVITY_CONNECTION_LABELS = { account: '官方登录', gemini: 'Gemini API Key' } as const;

/** 原生表单中的空值表示账号登录；未知 provider 不得呈现为官方账号。 */
export function antigravityConnectionField(provider: string | undefined): AntigravityConnection | undefined {
  if (provider === undefined) return undefined;
  const value = provider.trim();
  if (!value) return 'account';
  return value === 'gemini' ? 'gemini' : undefined;
}
