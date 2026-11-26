import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentModel } from '@agentdeck/shared/conversation';
import { object, string } from '../../common/configuration/fields';
import { startManagementBackend } from '../management/management-process';
import { antigravityAccountReadEnvironment } from '../run/process-environment';

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const family = (id: string) => id.replace(/-(low|medium|high|xhigh|max)(?:-effort)?$/, '');

export class OrchestratorCatalogError extends Error {
  constructor(readonly models: AgentModel[]) {
    super('编排器模型读取失败，请重新获取模型。');
  }
}

/** 角色白名单来自当前 CLI，匹配原生型号而非显示名；保存时仍使用完整显示标签。 */
export function withOrchestratorRoles(models: AgentModel[], flagsValue: unknown, catalogValue: unknown): AgentModel[] {
  const experiments = list(object(object(flagsValue).experimentConfig).experiments).map(object);
  const enabled = experiments.find((item) => item.keyString === 'enable-orchestrator-model-selection');
  const roles = experiments.find((item) => item.keyString === 'orchestrator-model-roles');
  if (!enabled) throw new OrchestratorCatalogError(models);
  if (enabled.disabled === true || roles?.disabled === true) return models;
  let choices: Record<string, unknown>;
  try {
    choices = object(JSON.parse(string(roles?.string)));
  } catch {
    throw new OrchestratorCatalogError(models);
  }
  if (!Array.isArray(choices.orchestrators) || !Array.isArray(choices.executors))
    throw new OrchestratorCatalogError(models);
  const native = object(object(object(catalogValue).response).models);
  if (!Object.keys(native).length) throw new OrchestratorCatalogError(models);
  return models.map((model) => {
    const source = object(native[model.id]);
    if (
      !string(source.model) ||
      source.model === 'MODEL_UNSPECIFIED' ||
      source.model === 'MODEL_GOOGLE_GEMINI_INTERNAL_BYOM' ||
      source.modelProvider === 'Custom' ||
      /^gemini-pro-(coordinator|orchestrator)(?:-|$)/.test(model.id) ||
      source.displayName !== model.label
    )
      return model;
    const orchestratorRoles: NonNullable<AgentModel['orchestratorRoles']> = [];
    if (list(choices.orchestrators).includes(family(model.id))) orchestratorRoles.push('planner');
    if (list(choices.executors).includes(family(model.id))) orchestratorRoles.push('executor');
    return orchestratorRoles.length ? { ...model, orchestratorRoles } : model;
  });
}

/** 只读原生账号目录；不创建会话，不调用 authenticate，也不执行模型请求。 */
export async function discoverOrchestratorRoles(
  models: AgentModel[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  request?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(12000);
  const signal = request ? AbortSignal.any([request, deadline]) : deadline;
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) ?? homedir();
  try {
    const backend = await startManagementBackend({
      cwd,
      env: antigravityAccountReadEnvironment(env),
      geminiDir: path.join(home, '.gemini'),
      signal,
      waitForSessionList: true,
    });
    try {
      const [flags, catalog] = await Promise.all([
        backend.request('GetMendelFlags', {}, 'page'),
        backend.request('GetAvailableModels', {}, 'page'),
      ]);
      return withOrchestratorRoles(models, flags, catalog);
    } finally {
      await backend.close();
    }
  } catch {
    request?.throwIfAborted();
    throw new OrchestratorCatalogError(models);
  }
}
