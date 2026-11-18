import type { AgentKind, AgentModel } from '@agentdeck/shared/conversation';
import type {
  ModelSecretInput,
  NativeModelSettingsDocument,
  NativeModelSettingsInput,
} from '@agentdeck/shared/settings';
import { ModelSecretInputSchema, NativeModelSettingsInputSchema } from '@agentdeck/shared/settings';
import type { EnvironmentSnapshot, ModelSettingsEnvironment } from '../agents/common/configuration/contracts';
import { modelSettingsRevision } from '../agents/common/configuration/environment';
import { NativeResourceError } from '../agents/common/configuration/errors';
import { parseModelConfig } from '../agents/common/configuration/fields';
import { ModelSettingsError } from '../agents/common/configuration/patch';
import { cliConfigurations } from '../agents/registry';
import { antigravityContextWindow } from '../agents/antigravity/models/context-window';
import {
  createNativeResourcesService,
  type NativeResourcesService,
  type NativeUserConfigWriter,
} from './resources/native-resources';
type Deps = {
  resources?: NativeResourcesService;
  environment?: ModelSettingsEnvironment;
  antigravityModels?: () => Promise<AgentModel[]>;
};
type NativeDocument = Awaited<ReturnType<NativeResourcesService['open']>>;

function secretProvider(input: ModelSecretInput, metadata: Pick<NativeModelSettingsDocument, 'fields' | 'providers'>) {
  const provider = input.provider ?? metadata.fields.find((field) => field.key === 'provider')?.value;
  const selected = metadata.providers?.find((item) => item.id === provider);
  if (provider && !selected) throw new NativeResourceError('invalid_request');
  const fields = selected?.fields ?? metadata.fields;
  if (!fields.some((field) => field.key === input.key && field.secret))
    throw new NativeResourceError('invalid_request');
  return provider;
}

function describe(
  agent: AgentKind,
  document: NativeDocument,
  environment: EnvironmentSnapshot | undefined,
): NativeModelSettingsDocument {
  const adapter = cliConfigurations[agent];
  const config = parseModelConfig(adapter.format, document.content);
  return {
    agent,
    revision: modelSettingsRevision(document.revision, environment),
    displayPath: document.resource.displayPath,
    ...adapter.describe(config, environment),
  };
}

/** 可视表单与原文编辑器共用同一文件事务、revision 和路径安全检查。 */
export function createModelSettingsService(deps: Deps = {}) {
  const resources = deps.resources ?? createNativeResourcesService();
  async function open(agent: AgentKind) {
    const catalog = await resources.list(agent);
    const target = catalog.entries.find((entry) => entry.kind === 'settings' && entry.scope === 'user');
    if (!target) throw new NativeResourceError('resource_missing');
    return resources.open(agent, target.id);
  }
  async function saveNative(
    agent: AgentKind,
    document: NativeDocument,
    content: string,
    writer: NativeUserConfigWriter,
  ): Promise<NativeDocument> {
    if (content === document.content) {
      const current = await resources.open(agent, document.resource.id);
      if (current.revision !== document.revision) throw new NativeResourceError('revision_conflict');
      return current;
    }
    const saved = await writer.save(document.resource.id, { content, revision: document.revision });
    return { ...saved, content };
  }
  async function response(agent: AgentKind, document: NativeDocument, environment: EnvironmentSnapshot | undefined) {
    const result = describe(agent, document, environment);
    const config = parseModelConfig(cliConfigurations[agent].format, document.content);
    result.warnings.push(...(await cliConfigurations[agent].advancedWarnings(config, deps.environment)));
    return result;
  }
  return {
    async readSecret(agent: AgentKind, input: ModelSecretInput) {
      const parsed = ModelSecretInputSchema.safeParse(input);
      if (!parsed.success) throw new NativeResourceError('invalid_request');
      const document = await open(agent);
      const adapter = cliConfigurations[agent];
      const environment = await adapter.readEnvironment(deps.environment);
      if (parsed.data.revision !== modelSettingsRevision(document.revision, environment))
        throw new NativeResourceError('revision_conflict');
      const config = parseModelConfig(adapter.format, document.content);
      const provider = secretProvider(parsed.data, adapter.describe(config, environment));
      return { value: adapter.readSecret(config, { ...parsed.data, provider }, environment) || null };
    },
    async contextWindow(agent: AgentKind, model?: string) {
      if (agent !== 'antigravity') return {};
      const document = await open(agent);
      const config = parseModelConfig('json', document.content);
      return antigravityContextWindow(config, model);
    },
    async read(agent: AgentKind) {
      const document = await open(agent);
      return response(agent, document, await cliConfigurations[agent].readEnvironment(deps.environment));
    },
    async save(agent: AgentKind, input: NativeModelSettingsInput) {
      const parsed = NativeModelSettingsInputSchema.safeParse(input);
      if (!parsed.success) throw new ModelSettingsError('模型配置请求格式不正确。');
      return resources.withUserWrite(agent, async (writer) => {
        const document = await open(agent);
        const environment = await cliConfigurations[agent].readEnvironment(deps.environment);
        if (input.revision !== modelSettingsRevision(document.revision, environment))
          throw new NativeResourceError('revision_conflict');
        const config = parseModelConfig(cliConfigurations[agent].format, document.content);
        const adapter = cliConfigurations[agent];
        const prepared = await adapter.prepare(config, parsed.data.changes, environment, {
          environment: deps.environment,
          modelCatalog: deps.antigravityModels,
        });
        const content = adapter.patch(document.content, config, prepared.changes);
        const connection = prepared.connection;
        const environmentSaved = await connection.save();
        let saved: NativeDocument;
        try {
          saved = await saveNative(agent, document, content, writer);
        } catch (error) {
          await connection.restore(environmentSaved);
          throw error;
        }
        // 回显使用已提交的快照，不重新解密，也不能因回显失败撤销已提交的连接。
        return response(agent, saved, environmentSaved);
      });
    },
  };
}
export type ModelSettingsService = ReturnType<typeof createModelSettingsService>;
