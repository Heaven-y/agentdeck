import type { AgentModel, AntigravityConnection } from '@agentdeck/shared/conversation';
import { findModel } from '../shared/model-identity';
import { standardEfforts } from '../shared/documented-models';
export function variant(id: string) {
  return /^(.*)-(low|medium|high|xhigh|max)$/.exec(id);
}

/** AGY 的强度是原生目录中的同族变体；自定义配置键不能按名称猜测。 */
export function antigravityEfforts(id: string, models: AgentModel[]): string[] {
  const selected = findModel(models, id);
  if (!selected || selected.modelId) return [];
  const family = variant(selected.id)?.[1];
  if (!family) return [];
  const levels = models
    .filter((model) => !model.modelId && variant(model.id)?.[1] === family)
    .map((model) => variant(model.id)![2]);
  return levels.length > 1 ? standardEfforts.filter((level) => levels.includes(level)) : [];
}

export const ANTIGRAVITY_CONNECTION_LABELS = { account: '官方登录', gemini: 'Gemini API Key' } as const;

/** 原生表单中的空值表示账号登录；未知 provider 不得呈现为官方账号。 */
export function antigravityConnectionField(provider: string | undefined): AntigravityConnection | undefined {
  if (provider === undefined) return undefined;
  const value = provider.trim();
  if (!value) return 'account';
  return value === 'gemini' ? 'gemini' : undefined;
}
