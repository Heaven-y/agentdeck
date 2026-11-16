import type { NativeModelSettingsInput } from '@agentdeck/shared/settings';
import { createHash } from 'node:crypto';
import { object, string, type ConfigObject } from '../../common/configuration/fields';
import { modelContextWindow } from '../../common/configuration/token-count';
import {
  antigravityModelId,
  antigravityModelsWithLabel,
  assertAntigravitySelection,
  equivalentAntigravityModels,
  selectedAntigravityModel,
} from './identity';

type Changes = NativeModelSettingsInput['changes'];
const owns = (changes: Changes, key: string) => Object.hasOwn(changes, key);

function antigravitySelection(config: ConfigObject, changes: Changes, previous?: ConfigObject) {
  const rawModel = selectedModelId(changes, previous);
  const model = rawModel || string(config.model);
  if (!model) throw new Error('请填写模型 ID。');
  const label = modelLabel(changes, previous) || declaredLabel(changes) || model;
  return { model, label };
}
/** 解析出原生 ID 时，changes.model 仍是原生显示名；label 取它而不是原始 ID。 */
function declaredLabel(changes: Changes) {
  return owns(changes, 'nativeModelId') && owns(changes, 'model') ? (changes.model?.trim() ?? '') : '';
}
function selectedModelId(changes: Changes, previous?: ConfigObject) {
  // prepare 解析出的原生 ID 才是 modelName 的可靠来源；标签只属于 config.model。
  const resolved = string(changes.nativeModelId);
  const raw = antigravityModelId(previous?.modelName);
  if (!owns(changes, 'model')) return resolved || raw;
  const model = changes.model?.trim();
  if (!model) throw new Error('请先选择模型，再修改名称或上下文窗口。');
  if (resolved) return resolved;
  // previous 已按本次选择解析；旧键可归一到另一 canonical 键，仍须沿用其真实 ID。
  return previous ? raw : model;
}
function modelLabel(changes: Changes, previous?: ConfigObject) {
  return owns(changes, 'displayName') ? changes.displayName?.trim() : string(previous?.label);
}
function shouldEditAntigravity(changes: Changes, previous?: ConfigObject) {
  return (
    ['displayName', 'contextWindow'].some((key) => owns(changes, key)) ||
    (!!previous && (owns(changes, 'baseUrl') || owns(changes, 'model') || owns(changes, 'modelProvider')))
  );
}
function applyWindow(entry: ConfigObject, changes: Changes) {
  if (!owns(changes, 'contextWindow')) return;
  const window = modelContextWindow(changes.contextWindow);
  if (window === null) delete entry.maxTokens;
  else entry.maxTokens = window;
}

function removeEquivalentEntries(config: ConfigObject, previous: ConfigObject | undefined, key: string) {
  if (!previous?.label) return;
  const matches = antigravityModelsWithLabel(config, string(previous.label));
  if (matches.length < 2 || !equivalentAntigravityModels(matches)) return;
  const models = object(object(config.customModelsConfig).customModels);
  for (const duplicate of matches) if (duplicate.key !== key) delete models[string(duplicate.key)];
}

function newModelKey(models: ConfigObject, model: string) {
  return models.agentdeck ? `agentdeck-${createHash('sha256').update(model).digest('hex').slice(0, 12)}` : 'agentdeck';
}
/**
 * URL 只放启动环境；model 按原生约定保存 label。
 *
 * 条目键只供本应用稳定标识；原生按 label 命中自定义覆盖，不能假定它接受条目键。
 */
export function patchAntigravityModel(config: ConfigObject, changes: Changes): boolean {
  // prepare 已解析原生身份；ID 和显示标签都不能重新当作工作台键。
  const nativeModelId = string(changes.nativeModelId);
  const requested = nativeModelId ? { nativeModelId } : (changes.model ?? undefined);
  const previous = selectedAntigravityModel(config, requested);
  if (config.modelProvider !== 'gemini' && !['displayName', 'contextWindow'].some((key) => owns(changes, key)))
    return false;
  if (!shouldEditAntigravity(changes, previous)) return false;
  assertAntigravitySelection(config, requested);
  if (config.modelProvider !== 'gemini') throw new Error('自定义模型需要选择 Gemini API Key 连接方式。');
  const customConfig = object(config.customModelsConfig);
  if (Array.isArray(customConfig.customModels)) throw new Error('原生自定义模型应为对象，请先在原始配置中修正。');
  const models = object(customConfig.customModels);
  const { model, label } = antigravitySelection(config, changes, previous);
  const key = string(previous?.key) || newModelKey(models, model);
  const entry: ConfigObject = {
    ...object(models[key]),
    modelName: antigravityModelId(model),
    label,
  };
  applyWindow(entry, changes);
  // 先按旧参数确认等价，再删除本应用遗留重复，避免下一次读取仍有同名歧义。
  removeEquivalentEntries(config, previous, key);
  models[key] = entry;
  config.customModelsConfig = { ...customConfig, customModels: models };
  config.model = label;
  // 新名称也必须能唯一启动；在候选内容写入文件前拒绝制造同名冲突。
  assertAntigravitySelection(config);
  return true;
}

export function legacyAntigravityBaseUrl(config: ConfigObject): string | undefined {
  const previous = selectedAntigravityModel(config);
  const modelName = string(previous?.modelName);
  if (!modelName.startsWith('gemini-api://')) return undefined;
  const body = modelName.slice('gemini-api://'.length);
  const index = body.indexOf('/models/');
  if (index <= 0) return undefined;
  const host = body.slice(0, index);
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}
