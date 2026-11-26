import type { AgentKind, AgentModel } from '@agentdeck/shared/conversation';
import { antigravityModelGroups } from '../antigravity/model-suggestions';
import { findModel } from './model-identity';

export type ModelCandidate = AgentModel & { searchTerms?: string[]; equivalentIds?: string[] };
export type ModelOrigin = 'native' | 'selection';
type ModelScope = AgentKind | { agent?: AgentKind; origin?: ModelOrigin };
type CandidateResolution = {
  selected?: ModelCandidate;
  equivalents: AgentModel[];
  fromCatalog: boolean;
  ambiguous?: boolean;
};

function unpackScope(scope?: ModelScope) {
  return typeof scope === 'string' ? { agent: scope, origin: undefined } : (scope ?? {});
}

function visibleModels(models: AgentModel[], visible?: string[]) {
  if (!visible) return models;
  const allowed = new Set(visible);
  return models.filter((model) => allowed.has(model.id));
}

function nativeModelId(matches: AgentModel[], current: string): string | undefined {
  const ids = new Set(
    matches.filter((model) => model.modelId || model.id !== current).map((model) => model.modelId || model.id),
  );
  if (!ids.size && matches.length === 1) return matches[0]!.id;
  return ids.size === 1 ? [...ids][0] : undefined;
}

function nativeSelection(matches: AgentModel[]): AgentModel | undefined {
  const configured = matches.filter((model) => model.modelId);
  if (configured.length === 1) return configured[0];
  if (configured.length) return undefined;
  return matches.length === 1 ? matches[0] : undefined;
}

function nativeIdCandidate(models: AgentModel[], current: string): CandidateResolution {
  const matches = models.filter((model) => model.modelId === current || (!model.modelId && model.id === current));
  if (!matches.length) {
    if (!findModel(models, current)) return unresolvedCandidate(models, current, 'antigravity');
    return { selected: undefined, equivalents: [], fromCatalog: true, ambiguous: true };
  }
  const conflictingKey = models.some((model) => model.id === current && model.modelId && model.modelId !== current);
  if (conflictingKey) {
    if (matches.length !== 1) return { selected: undefined, equivalents: [], fromCatalog: true, ambiguous: true };
    return { selected: { ...matches[0]!, modelId: current }, equivalents: matches, fromCatalog: true };
  }
  const selected: ModelCandidate = {
    id: current,
    label: current,
    modelId: current,
    searchTerms: matches.map(searchText),
  };
  const pair = antigravityModelGroups(matches).find((entries) => entries.length === 2);
  return {
    selected,
    equivalents: pair ?? (matches.length === 1 ? matches : matches.filter((model) => !model.modelId)),
    fromCatalog: false,
  };
}

function nativeCurrentCandidate(models: AgentModel[], current: string) {
  const matches = models.filter((model) => model.label === current);
  if (!matches.length) return nativeIdCandidate(models, current);
  const modelId = nativeModelId(matches, current);
  if (!modelId) return { selected: undefined, equivalents: [], fromCatalog: true, ambiguous: true };
  const pair = antigravityModelGroups(models).find((entries) => entries.length === 2 && entries[0]!.label === current);
  const equivalents = pair ?? (matches.length === 1 ? matches : matches.filter((model) => !model.modelId));
  const resolved = findModel(models, current);
  if (resolved && resolved.label !== current) {
    const selected = nativeSelection(matches);
    if (!selected) return { selected: undefined, equivalents: [], fromCatalog: true, ambiguous: true };
    return { selected: { ...selected, modelId }, equivalents, fromCatalog: true };
  }
  const selected: ModelCandidate = { id: current, label: current, modelId, searchTerms: matches.map(searchText) };
  return { selected, equivalents, fromCatalog: false };
}

function unambiguousModel(models: AgentModel[], current: string): AgentModel | undefined {
  const sameLabel = models.filter((model) => model.label === current);
  if (sameLabel.length === 1) return sameLabel[0];
  const nativeModels = sameLabel.filter((model) => !model.modelId);
  if (nativeModels.length !== 1) return undefined;
  const native = nativeModels[0]!;
  return sameLabel.every((model) => model === native || model.modelId === native.id) ? native : undefined;
}

function unresolvedCandidate(models: AgentModel[], current: string, agent?: AgentKind) {
  // 历史或缓存中的原生名称可能不在 ID 字段；仅在型号关系明确时补充展示元数据。
  const match = agent === 'antigravity' ? unambiguousModel(models, current) : undefined;
  const equivalents =
    (agent === 'antigravity' &&
      antigravityModelGroups(models).find((entries) => entries.length === 2 && entries[0]!.label === current)) ||
    (match ? [match] : []);
  const selected: ModelCandidate = {
    id: current,
    label: current,
    ...(match ? { modelId: match.modelId || match.id } : {}),
  };
  if (equivalents.length) selected.searchTerms = equivalents.map(searchText);
  return { selected, equivalents, fromCatalog: false };
}

function currentCandidate(
  models: AgentModel[],
  current: string,
  agent?: AgentKind,
  origin?: ModelOrigin,
): CandidateResolution {
  if (agent === 'antigravity' && origin === 'native' && current) return nativeCurrentCandidate(models, current);
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
  return unresolvedCandidate(models, current, agent);
}

/** 当前值只补展示元数据，保留点击时交回的选择身份。 */
export function currentModelCandidate(
  models: AgentModel[],
  current: string,
  agent?: AgentKind,
  origin?: ModelOrigin,
): ModelCandidate | undefined {
  return currentCandidate(models, current, agent, origin).selected;
}

/** 当前覆盖不在目录里时仍可选择；别名和 [1m] 的匹配继续交给原有身份规则。 */
export function modelCandidates(
  models: AgentModel[],
  current: string,
  visible?: string[],
  scope?: ModelScope,
): ModelCandidate[] {
  const { agent, origin } = unpackScope(scope);
  const { selected, equivalents, fromCatalog, ambiguous } = currentCandidate(models, current, agent, origin);
  const unique = new Map(visibleModels(models, visible).map((model) => [model.id, model]));
  for (const model of equivalents) unique.delete(model.id);
  if (selected) unique.delete(selected.id);
  const candidates = fromCatalog && selected ? [selected, ...unique.values()] : [...unique.values()];
  // 只合并真实目录项，补出的当前值不能充当原生身份依据。
  const choices =
    agent === 'antigravity'
      ? combinedCandidates(candidates, ambiguous ? current : undefined, selected?.id)
      : candidates;
  return !fromCatalog && selected ? [selected, ...choices] : choices;
}

function combinedCandidates(models: AgentModel[], separateLabel?: string, current?: string): ModelCandidate[] {
  return antigravityModelGroups(models).flatMap((entries) =>
    entries[0]!.label === separateLabel
      ? entries.map((model) => combinedCandidate([model]))
      : [combinedCandidate(entries, current)],
  );
}

function combinedCandidate(entries: AgentModel[], current?: string): ModelCandidate {
  const selected = entries.find((model) => model.id === current) ?? entries[0]!;
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
