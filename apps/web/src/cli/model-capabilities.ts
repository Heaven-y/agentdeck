import {
  ClaudeEffortSchema,
  type AgentCapabilities,
  type AgentKind,
  type AgentModel,
} from '@agentdeck/shared/conversation';
import { findModel } from './shared/model-identity';

export function modelEfforts(agent: AgentKind, id: string, models: AgentModel[]): string[] {
  const selected = findModel(models, id);
  // AGY 原生带档位的型号就是完整选择；不再按同族名称拼出另一组选项。
  if (agent === 'antigravity' && selected && !selected.modelId && /-(low|medium|high|xhigh|max)$/i.test(selected.id))
    return [];
  return [...new Set(selected?.reasoningEfforts ?? [])].filter(
    (level) => agent !== 'claude' || ClaudeEffortSchema.safeParse(level).success,
  );
}

export function configuredModelEffort(id: string, catalog?: AgentCapabilities): string | undefined {
  if (!catalog) return undefined;
  const selected = findModel(catalog.models, id);
  if (id === catalog.defaultModel || (selected && selected === findModel(catalog.models, catalog.defaultModel ?? '')))
    return catalog.defaultReasoningEffort ?? selected?.defaultReasoningEffort;
  return selected?.defaultReasoningEffort;
}
