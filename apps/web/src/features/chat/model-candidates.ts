import type { AgentKind, AgentModel } from '@agentdeck/shared/conversation';
import { antigravityModelGroups } from '../../cli/antigravity/model-suggestions';
import { findModel } from '../../cli/shared/model-identity';

export type ModelCandidate = AgentModel & { searchTerms?: string[]; equivalentIds?: string[] };

function currentCandidate(models: AgentModel[], current: string, agent?: AgentKind) {
  const resolved = findModel(models, current);
  const nativePair =
    agent === 'antigravity' && resolved
      ? antigravityModelGroups(models).find(
          (entries) => entries.length === 2 && entries.includes(resolved) && entries.every((model) => !model.modelId),
        )
      : undefined;
  if (nativePair) {
    const selected = combinedCandidate([resolved!, ...nativePair.filter((model) => model !== resolved)]);
    return { selected, equivalents: nativePair, fromCatalog: true };
  }
  if (resolved || !current) return { selected: resolved, equivalents: [], fromCatalog: true };
  // 历史中的原生名称可能不在 ID 字段；只按已确认的一对身份消除额外候选。
  const equivalents =
    (agent === 'antigravity' &&
      antigravityModelGroups(models).find((entries) => entries.length === 2 && entries[0]!.label === current)) ||
    [];
  const selected: ModelCandidate = { id: current, label: current };
  if (equivalents.length) selected.searchTerms = equivalents.map(searchText);
  return { selected, equivalents, fromCatalog: false };
}

/** 当前值只补展示元数据，保留点击时交回的选择身份。 */
export function currentModelCandidate(
  models: AgentModel[],
  current: string,
  agent?: AgentKind,
): ModelCandidate | undefined {
  return currentCandidate(models, current, agent).selected;
}

/** 当前覆盖不在目录里时仍可选择；别名和 [1m] 的匹配继续交给原有身份规则。 */
export function modelCandidates(
  models: AgentModel[],
  current: string,
  visible?: string[],
  agent?: AgentKind,
): ModelCandidate[] {
  const { selected, equivalents, fromCatalog } = currentCandidate(models, current, agent);
  const allowed = visible && new Set(visible);
  const unique = new Map(models.filter((model) => !allowed || allowed.has(model.id)).map((model) => [model.id, model]));
  for (const model of equivalents) unique.delete(model.id);
  if (selected) unique.delete(selected.id);
  const candidates = fromCatalog && selected ? [selected, ...unique.values()] : [...unique.values()];
  // 只合并真实目录项，补出的当前值不能充当原生身份依据。
  const choices = agent === 'antigravity' ? combinedCandidates(candidates) : candidates;
  return !fromCatalog && selected ? [selected, ...choices] : choices;
}

function combinedCandidates(models: AgentModel[]): ModelCandidate[] {
  return antigravityModelGroups(models).map(combinedCandidate);
}

function combinedCandidate(entries: AgentModel[]): ModelCandidate {
  const selected = entries[0]!;
  if (entries.length === 1) return selected;
  const native = entries.every((model) => !model.modelId)
    ? entries.find((model) => model.id !== model.label)
    : undefined;
  return {
    ...selected,
    ...(native ? { modelId: native.id } : {}),
    searchTerms: entries.map(searchText),
    equivalentIds: entries.flatMap((model: ModelCandidate) => model.equivalentIds ?? [model.id]),
  };
}

/** 设置页的显示范围清单沿用对话菜单的身份合并，避免把原生别名重复列成两个模型。 */
export function visibilityCandidates(agent: AgentKind, models: AgentModel[]): ModelCandidate[] {
  return agent === 'antigravity' ? combinedCandidates(models) : models;
}

function searchText(model: ModelCandidate): string {
  return `${model.label} ${model.id} ${model.modelId ?? ''} ${model.searchTerms?.join(' ') ?? ''}`;
}

export function matchingModels(models: ModelCandidate[], phrase: string): ModelCandidate[] {
  const query = phrase.trim().toLocaleLowerCase();
  return query ? models.filter((model) => searchText(model).toLocaleLowerCase().includes(query)) : models;
}
