import type { NativeContextWindow } from '@agentdeck/shared/settings';
import { object, string, type ConfigObject } from '../common/configuration/fields';
import { antigravityContextWindow, antigravityContextWindowSnapshot } from './context-window';
import { antigravityModelSelector, readAntigravityModelConfig } from './model-catalog';
import {
  antigravitySelectionWarning,
  antigravityModelsWithLabel,
  equivalentAntigravityModels,
  selectedAntigravityModel,
} from './configuration/identity';

export class AntigravityModelSelectionError extends Error {}
type NativeSettings = { customModelsConfig: ConfigObject };
export type AntigravityLaunchSelection = {
  model?: string;
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

/** 启动参数和窗口快照共用同次读取；新建与 --conversation 续聊使用相同选择规则。 */
export async function antigravityLaunchSelection(
  env: NodeJS.ProcessEnv,
  requested?: string,
  readWindow: typeof antigravityContextWindow = antigravityContextWindow,
): Promise<AntigravityLaunchSelection> {
  const settings = await readAntigravityModelConfig({ env });
  const warning = antigravitySelectionWarning(settings, requested);
  if (warning) throw new AntigravityModelSelectionError(warning);
  const nativeSettings = normalizeLaunchSettings(settings, requested);
  const model = settings.modelProvider === 'gemini' ? antigravityModelSelector(settings, requested) : requested;
  // 自定义窗口直接读取；内置模型补充有界快照，避免进入运行态后丢失已知窗口。
  const custom = settings.modelProvider === 'gemini' && selectedAntigravityModel(settings, requested);
  const contextWindow = custom
    ? await antigravityContextWindow(settings, requested)
    : settings.modelProvider === 'gemini' && (requested || string(settings.model))
      ? await antigravityContextWindowSnapshot(settings, requested, readWindow)
      : undefined;
  return { model, contextWindow, ...(nativeSettings ? { nativeSettings } : {}) };
}
