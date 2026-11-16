import { has, object, string, type ConfigObject } from '../../common/configuration/fields';
import { isDeepStrictEqual } from 'node:util';
import { ModelSettingsError } from '../../common/configuration/patch';
/** 旧配置把地址拼进 modelName；展示与迁移时只提取真实模型 ID。 */
export function antigravityModelId(value: unknown): string {
  const raw = string(value).trim();
  if (!raw.startsWith('gemini-api://')) return raw;
  const model = raw.slice('gemini-api://'.length).split('/models/').at(-1) ?? '';
  return model.split(/[?#]/, 1)[0]!.trim();
}

/** 标签分组只比较 label；对象键属于工作台选择身份，不能混入去重判断。 */
export function antigravityModelsWithLabel(config: ConfigObject, label: string): ConfigObject[] {
  if (!label) return [];
  return Object.entries(object(object(config.customModelsConfig).customModels))
    .map(([key, value]): ConfigObject => ({ ...object(value), key }))
    .filter((entry) => entry.label === label);
}

/** string 是工作台显式选择；目录已解析的 ID 仅按原生 modelName 查找。 */
type ModelSelection = string | { nativeModelId: string };
function selectionValue(config: ConfigObject, requested?: ModelSelection): string {
  return typeof requested === 'object' ? requested.nativeModelId : string(requested ?? config.model);
}

/** 原生持久值优先按 label；只有显式工作台选择才优先按稳定键。 */
export function matchingAntigravityModels(config: ConfigObject, requested?: ModelSelection): ConfigObject[] {
  const models = object(object(config.customModelsConfig).customModels);
  const selectedKey = selectionValue(config, requested);
  if (!selectedKey) return [];
  const entries = Object.entries(models).map(([key, value]): ConfigObject => ({ ...object(value), key }));
  if (typeof requested === 'object')
    return entries.filter((entry) => antigravityModelId(entry.modelName) === selectedKey);
  const keyed = has(models, selectedKey) ? [{ ...object(models[selectedKey]), key: selectedKey }] : [];
  if (requested !== undefined && keyed.length) return keyed;
  const labelled = antigravityModelsWithLabel(config, selectedKey);
  if (labelled.length) return labelled;
  if (keyed.length) return keyed;
  return entries.filter(
    (entry) => entry.modelName === selectedKey || antigravityModelId(entry.modelName) === selectedKey,
  );
}

/** 仅合并本应用遗留的等价条目；真实模型 ID 或额外参数不同仍视为冲突。 */
export function equivalentAntigravityModels(entries: ConfigObject[]): ConfigObject | undefined {
  if (entries.length === 1) return entries[0];
  if (!entries.length || entries.some((entry) => !/^agentdeck(?:-|$)/.test(string(entry.key)))) return;
  const canonical = entries.find((entry) => entry.modelName && entry.modelName !== entry.label);
  if (!canonical) return;
  const parameters = (entry: ConfigObject) => {
    const { key: _key, modelName, ...rest } = entry;
    return { ...rest, modelName: modelName === entry.label ? canonical.modelName : modelName };
  };
  return entries.every((entry) => isDeepStrictEqual(parameters(entry), parameters(canonical))) ? canonical : undefined;
}

export function selectedAntigravityModel(config: ConfigObject, requested?: ModelSelection): ConfigObject | undefined {
  const matches = matchingAntigravityModels(config, requested);
  const selected = equivalentAntigravityModels(matches);
  if (matches.length !== 1 || !selected?.label) return selected;
  const aliases = antigravityModelsWithLabel(config, string(selected.label));
  return equivalentAntigravityModels(aliases) ?? selected;
}

function modelConfigWarning(config: ConfigObject): string | undefined {
  if (config.model !== undefined && typeof config.model !== 'string')
    return '原生模型配置格式错误，请将模型设置为字符串。';
  if (config.modelProvider !== undefined && typeof config.modelProvider !== 'string')
    return '原生模型连接方式格式错误，请在原始配置中修正。';
  const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
  const custom = config.customModelsConfig;
  const models = object(custom).customModels;
  if (
    (custom !== undefined && !record(custom)) ||
    (models !== undefined && !record(models)) ||
    Object.values(object(models)).some(
      (value) =>
        !record(value) ||
        !string(object(value).modelName).trim() ||
        (object(value).label !== undefined && typeof object(value).label !== 'string'),
    )
  )
    return '原生自定义模型配置格式错误，请在原始配置中修正。';
}

export function antigravitySelectionWarning(config: ConfigObject, requested?: ModelSelection): string | undefined {
  const invalid = modelConfigWarning(config);
  if (invalid) return invalid;
  if (
    typeof requested !== 'object' &&
    /^agentdeck(?:$|-(?:window-)?[a-f0-9]{12}$)/.test(selectionValue(config, requested)) &&
    !matchingAntigravityModels(config, requested).length
  )
    return '模型配置已更新，当前应用模型键已失效，请重新选择模型后发送。';
  const selected = selectedAntigravityModel(config, requested);
  // 即便本应用按键选定，最终交给原生的是 label，也必须检查 label 是否唯一。
  const matches = selected?.label
    ? antigravityModelsWithLabel(config, string(selected.label))
    : matchingAntigravityModels(config, requested);
  if (matches.length > 1 && !equivalentAntigravityModels(matches))
    return '同名 Antigravity 模型配置存在冲突，请在原始配置中使用不同名称后再保存或启动。';
}

export function assertAntigravitySelection(config: ConfigObject, requested?: ModelSelection): void {
  const warning = antigravitySelectionWarning(config, requested);
  if (warning) throw new ModelSettingsError(warning);
}
