import type { NativeContextWindow } from '@agentdeck/shared/settings';
import { randomUUID } from 'node:crypto';
import { object, string, type ConfigObject } from '../common/configuration/fields';
import {
  antigravityContextWindow,
  antigravityContextWindowSnapshot,
  antigravityDefaultReasoningEffort,
} from './context-window';
import { antigravityModelSelector, readAntigravityModelConfig } from './model-catalog';
import {
  antigravityModelId,
  antigravitySelectionWarning,
  antigravityModelsWithLabel,
  equivalentAntigravityModels,
  selectedAntigravityModel,
} from './configuration/identity';

export class AntigravityModelSelectionError extends Error {}
type NativeSettings = { customModelsConfig: ConfigObject };
type LaunchOptions = { readEffort?: typeof antigravityDefaultReasoningEffort; explicitEffort?: string };
export type AntigravityLaunchSelection = {
  model?: string;
  sessionModel?: string;
  defaultReasoningEffort?: 'low' | 'medium' | 'high';
  contextWindow?: NativeContextWindow;
  nativeSettings?: NativeSettings;
};

/** 原生按 label 选条目；显式旧键也必须先消除同 label 的等价遗留项。 */
function normalizeLaunchSettings(settings: ConfigObject, requested?: string): NativeSettings | undefined {
  const selected = selectedAntigravityModel(settings, requested);
  if (settings.modelProvider !== 'gemini' || !string(selected?.label)) return;
  const customConfig = object(settings.customModelsConfig);
  const models = object(customConfig.customModels);
  const matches = antigravityModelsWithLabel(settings, string(selected?.label));
  if (matches.length < 2) return;
  const canonical = equivalentAntigravityModels(matches);
  if (!canonical)
    throw new AntigravityModelSelectionError(
      '同名 Antigravity 模型配置存在冲突，请在原始配置中使用不同名称后再保存或启动。',
    );
  const retained = { ...models };
  for (const entry of matches) if (entry.key !== canonical.key) delete retained[string(entry.key)];
  // --settings 整体替换映射，必须保留未参与消歧的模型与所有未知参数。
  return { customModelsConfig: { ...customConfig, customModels: retained } };
}

function runtimeAlias(models: ConfigObject): string {
  const names = new Set(Object.keys(models));
  for (const value of Object.values(models)) {
    names.add(string(object(value).label));
    names.add(string(object(value).modelName));
  }
  let alias: string;
  do alias = `AgentDeck Runtime ${randomUUID()}`;
  while (names.has(alias));
  return alias;
}

function runtimeModelName(value: unknown): unknown {
  const raw = string(value).trim();
  const legacy = /^gemini-api:\/\/(?:https?:\/\/)?[^/?#\s]+(?:\/[^/?#\s]+)*\/models\/[^/?#\s]+(?:[?#][^\s]*)?$/;
  return legacy.test(raw) ? antigravityModelId(raw) : value;
}

function windowOverride(settings: ConfigObject, selected: ConfigObject | undefined, normalized?: NativeSettings) {
  const window = selected?.maxTokens;
  if (typeof window !== 'number' || !Number.isSafeInteger(window) || window <= 0) return undefined;
  const customConfig = object(normalized?.customModelsConfig ?? settings.customModelsConfig);
  const models = object(customConfig.customModels);
  const key = string(selected?.key);
  if (!key || !Object.hasOwn(models, key)) throw new AntigravityModelSelectionError('无法定位所选模型配置。');
  const alias = runtimeAlias(models);
  const entry = object(models[key]);
  return {
    alias,
    nativeSettings: {
      customModelsConfig: {
        ...customConfig,
        customModels: { ...models, [key]: { ...entry, modelName: runtimeModelName(entry.modelName), label: alias } },
      },
    },
  };
}

function applyWindowOverride(
  settings: ConfigObject,
  selected: ConfigObject | undefined,
  selection: AntigravityLaunchSelection,
): AntigravityLaunchSelection {
  const runtime = windowOverride(settings, selected, selection.nativeSettings);
  return runtime
    ? {
        ...selection,
        model: runtime.alias,
        sessionModel: selection.model,
        contextWindow: { ...selection.contextWindow, model: selection.model },
        nativeSettings: runtime.nativeSettings,
      }
    : selection;
}

async function addNativeDefaultEffort(
  selection: AntigravityLaunchSelection,
  custom: ConfigObject | undefined,
  env: NodeJS.ProcessEnv,
  options?: LaunchOptions,
): Promise<AntigravityLaunchSelection> {
  if (selection.sessionModel === undefined || options?.explicitEffort) return selection;
  try {
    const defaultReasoningEffort = await (options?.readEffort ?? antigravityDefaultReasoningEffort)(
      string(runtimeModelName(custom?.modelName)),
      undefined,
      env,
    );
    return defaultReasoningEffort ? { ...selection, defaultReasoningEffort } : selection;
  } catch {
    throw new AntigravityModelSelectionError('无法读取或识别原生推理强度，请检查原生模型目录后重试。');
  }
}

/** 启动参数和窗口快照共用同次读取；新建与 --conversation 续聊使用相同选择规则。 */
export async function antigravityLaunchSelection(
  env: NodeJS.ProcessEnv,
  requested?: string,
  readWindow: typeof antigravityContextWindow = antigravityContextWindow,
  options?: LaunchOptions,
): Promise<AntigravityLaunchSelection> {
  const settings = await readAntigravityModelConfig({ env });
  const warning = antigravitySelectionWarning(settings, requested);
  if (warning) throw new AntigravityModelSelectionError(warning);
  const nativeSettings = normalizeLaunchSettings(settings, requested);
  const model = settings.modelProvider === 'gemini' ? antigravityModelSelector(settings, requested) : requested;
  // 自定义窗口直接读取；内置模型补充有界快照，避免进入运行态后丢失已知窗口。
  const custom = settings.modelProvider === 'gemini' ? selectedAntigravityModel(settings, requested) : undefined;
  const contextWindow = custom
    ? await antigravityContextWindow(settings, requested)
    : settings.modelProvider === 'gemini' && (requested || string(settings.model))
      ? await antigravityContextWindowSnapshot(settings, requested, readWindow)
      : undefined;
  // 同名内置选择可能绕过自定义窗口；仅本轮改用不会撞名的原生标签。
  const selection = applyWindowOverride(settings, custom, {
    model,
    contextWindow,
    ...(nativeSettings ? { nativeSettings } : {}),
  });
  return addNativeDefaultEffort(selection, custom, env, options);
}
