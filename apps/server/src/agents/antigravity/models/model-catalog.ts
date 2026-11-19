import type { AgentModel, AntigravityConnection } from '@agentdeck/shared/conversation';
import { homedir } from 'node:os';
import path from 'node:path';
import { readConfigFile } from '../../../platform/files/safe-file';
import { parseModelConfig, type ConfigObject } from '../../common/configuration/fields';
import { antigravityModelId, assertAntigravitySelection, selectedAntigravityModel } from '../configuration/identity';

type Options = { homeDir?: string; env?: NodeJS.ProcessEnv };
type CustomModel = { modelName: string; label?: string; maxTokens?: number };
export type AntigravityModelSettings = {
  model?: string;
  modelProvider?: string;
  customModelsConfig?: { customModels: Record<string, CustomModel> };
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

function customModels(value: unknown): Record<string, CustomModel> {
  const result: Record<string, CustomModel> = {};
  for (const [key, raw] of Object.entries(object(value))) {
    const item = object(raw);
    if (!text(item.modelName)) continue;
    const model: CustomModel = { modelName: text(item.modelName) };
    if (text(item.label)) model.label = text(item.label);
    if (typeof item.maxTokens === 'number' && Number.isSafeInteger(item.maxTokens) && item.maxTokens > 0)
      model.maxTokens = item.maxTokens;
    result[key] = model;
  }
  return result;
}

function modelSettings(config: ConfigObject): AntigravityModelSettings {
  return {
    model: text(config.model) || undefined,
    modelProvider: text(config.modelProvider) || undefined,
    customModelsConfig: { customModels: customModels(object(config.customModelsConfig).customModels) },
  };
}

function connectionFor(value: unknown): AntigravityConnection | undefined {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return 'account';
  return text(value) === 'gemini' ? 'gemini' : undefined;
}

/** 仅读取模型白名单；复制到隔离发现目录时不带入 MCP、插件、Hooks 或认证。 */
export async function readAntigravityModelSettings(options: Options = {}) {
  return modelSettings(await readAntigravityModelConfig(options));
}

/** 发现使用同一份设置快照判定身份，不把内部身份复制到隔离的原生配置。 */
export async function readAntigravityModelCatalogSettings(options: Options) {
  const config = await readAntigravityModelConfig(options);
  return { settings: modelSettings(config), connection: connectionFor(config.modelProvider) };
}

/** 本机只读，供命中目录缓存使用，不启动 CLI 或解析认证材料。 */
export async function readAntigravityConnection(options: Options = {}): Promise<AntigravityConnection | undefined> {
  return connectionFor((await readAntigravityModelConfig(options)).modelProvider);
}

/** 启动时保留额外模型参数参与冲突检查；不得将此原文返回前端或写进日志。 */
export async function readAntigravityModelConfig(options: Options = {}) {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? (process.platform === 'win32' ? env.USERPROFILE : env.HOME) ?? homedir();
  const { content } = await readConfigFile(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'));
  if (!content.trim()) return {};
  return parseModelConfig('json', content);
}

/**
 * 传给 `--model` 的必须是原生认得的型号：自定义条目按 label 命中。
 *
 * 本应用的条目键（如 `agentdeck-window-0a3f9f11eef9`）只是稳定标识；
 * 旧实现直接传键曾导致配置窗口未被采用，因此必须先解析原生选择值。
 * 原生 ID 唯一对应自定义条目时沿用该别名覆盖；未匹配自定义条目的 ID 原样透传。
 */
export function antigravityModelSelector(settings: AntigravityModelSettings, requested?: string): string | undefined {
  assertAntigravitySelection(settings, requested);
  const selected = selectedAntigravityModel(settings, requested);
  return selected
    ? text(selected.label) || antigravityModelId(selected.modelName) || text(selected.key)
    : text(requested) || undefined;
}

export function configuredAntigravityDefault(settings: AntigravityModelSettings): string | undefined {
  const selected = settings.modelProvider === 'gemini' ? selectedAntigravityModel(settings) : undefined;
  return text(selected?.key) || settings.model;
}

/** 目录以稳定键标识，发送时统一翻译为原生 label；窗口不从标题猜测。 */
export function configuredAntigravityModels(settings: AntigravityModelSettings): AgentModel[] {
  const result = new Map<string, AgentModel>();
  const entries = Object.entries(settings.customModelsConfig?.customModels ?? {});
  if (settings.modelProvider === 'gemini') {
    for (const [key, model] of entries) {
      const label = model.label || key;
      result.set(key, { id: key, label, modelId: antigravityModelId(model.modelName), description: '原生自定义模型' });
    }
  }
  const selectedCustom =
    settings.modelProvider === 'gemini' &&
    entries.some(([key, model]) => [key, model.label, antigravityModelId(model.modelName)].includes(settings.model));
  if (settings.model && !selectedCustom)
    result.set(settings.model, { id: settings.model, label: settings.model, description: '原生默认模型' });
  return [...result.values()];
}

/** 本机 agy models 返回已验证的两列 TSV；格式改变时不把说明文字当作模型。 */
export function parseAntigravityModelList(output: string): AgentModel[] {
  const result = new Map<string, AgentModel>();
  for (const line of output.split(/\r?\n/).filter((entry) => entry.trim())) {
    const columns = line.split('\t');
    if (
      columns.length !== 2 ||
      !columns.every(
        (column) =>
          column.trim() && [...column].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
      )
    )
      throw new Error('Antigravity 模型列表格式发生变化。');
    const id = columns[0]!.trim();
    result.set(id, { id, label: columns[1]!.trim() });
  }
  return [...result.values()];
}
