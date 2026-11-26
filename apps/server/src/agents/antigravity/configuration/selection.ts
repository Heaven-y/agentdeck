import type { AgentModel } from '@agentdeck/shared/conversation';
import type { NativeModelSettingsInput } from '@agentdeck/shared/settings';
import { object, string, type ConfigObject } from '../../common/configuration/fields';
import { discoverAntigravityModels } from '../models/model-discovery';
import { assertAntigravitySelection, selectedAntigravityModel } from './identity';
import { ModelSettingsError } from '../../common/configuration/patch';
import { antigravityAccountReadEnvironment } from '../run/process-environment';
import { OrchestratorCatalogError } from '../models/orchestrator';

type Changes = NativeModelSettingsInput['changes'];
export type AntigravityModelCatalog = () => Promise<AgentModel[]>;

/** 复用隔离目录发现，仅取 CLI 内置 ID/label；不携带真实密钥或访问服务端点。 */
export const nativeAntigravityModels: AntigravityModelCatalog = () =>
  discoverAntigravityModels(
    { modelProvider: 'gemini' },
    {
      ...process.env,
      GEMINI_API_KEY: 'local-model-catalog',
      AGY_ADC_AUTH: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
    },
  );

export async function antigravityOrchestratorChanges(
  config: ConfigObject,
  changes: Changes,
  env: NodeJS.ProcessEnv,
  discover?: AntigravityModelCatalog,
): Promise<Changes> {
  const fields = [
    ['orchestratorPlanner', 'planner'],
    ['orchestratorExecutor', 'executor'],
  ] as const;
  const edited = fields.filter(([key]) => changes[key]?.trim());
  if (!edited.length) return changes;
  if (string(Object.hasOwn(changes, 'modelProvider') ? changes.modelProvider : config.modelProvider).trim())
    throw new ModelSettingsError('编排器使用 Antigravity 账号登录。');
  const models = await (
    discover ?? (() => discoverAntigravityModels({}, antigravityAccountReadEnvironment(env)))
  )().catch((error: unknown) => {
    throw new ModelSettingsError(
      error instanceof OrchestratorCatalogError ? error.message : '编排器模型读取失败，请重新获取模型。',
    );
  });
  const result = { ...changes };
  for (const [key, role] of edited) {
    const matches = models.filter(
      (model) => model.orchestratorRoles?.includes(role) && [model.id, model.label].includes(changes[key]!.trim()),
    );
    if (matches.length !== 1) throw new ModelSettingsError('请选择对应角色的可用模型，可先重新获取模型。');
    result[key] = matches[0]!.label;
  }
  return result;
}

function requestedModel(config: ConfigObject, changes: Changes): { model: string; requested?: string } {
  if (Object.hasOwn(changes, 'model'))
    return { model: changes.model?.trim() ?? '', requested: changes.model ?? undefined };
  // 只改模型名称或上下文窗口时也要落到具体模型上，否则自定义条目没有可归属的型号。
  return {
    model: ['modelProvider', 'displayName', 'contextWindow'].some((key) => Object.hasOwn(changes, key))
      ? string(config.model)
      : '',
  };
}

function explicitCustomConnection(config: ConfigObject, changes: Changes): boolean {
  return !!changes.baseUrl?.trim() || Object.keys(object(object(config.customModelsConfig).customModels)).length > 0;
}

async function availableModels(discover: AntigravityModelCatalog): Promise<AgentModel[] | undefined> {
  try {
    return await discover();
  } catch {
    return undefined;
  }
}

/** 原生默认保存 label；未知服务 ID 登记为自定义模型，防止 CLI 静默回退默认。 */
export async function antigravitySelectionChanges(
  config: ConfigObject,
  changes: Changes,
  discover: AntigravityModelCatalog,
): Promise<Changes> {
  if ((changes.modelProvider ?? config.modelProvider) !== 'gemini') return changes;
  const { model, requested } = requestedModel(config, changes);
  assertAntigravitySelection(config, requested);
  if (!model || selectedAntigravityModel(config, requested)) return changes;
  const models = await availableModels(discover);
  const native = models?.find((entry) => [entry.id, entry.label].includes(model));
  // 自定义条目的 modelName 必须是原生 ID；label 只用于 config.model 与展示。
  if (native) return { ...changes, model: native.label, nativeModelId: native.id };
  if (!models && !explicitCustomConnection(config, changes)) return changes;
  return { ...changes, model, displayName: changes.displayName ?? model };
}
