import type { CliConfiguration } from '../../common/configuration/contracts';
import { NativeConfigError } from '../../common/configuration/legacy-errors';
import { validateUrl } from '../../common/configuration/patch';
import {
  antigravityConnectionChanges,
  modelConnectionFields,
  modelEnvironmentWarnings,
  nativeModelChanges,
  prepareModelConnection,
  readModelEnvironment,
} from './environment';
import { antigravityFields } from './fields';
import { antigravitySelectionWarning } from './identity';
import { launchVariables, validAntigravityProxy } from './launch';
import { patch } from './patch';
import { antigravityPlan } from './resources';
import { antigravitySelectionChanges, nativeAntigravityModels } from './selection';
export const configuration: CliConfiguration = {
  format: 'json',
  patch,
  resources: antigravityPlan,
  launchVariables,
  instructionNames: ['AGENTS.md', 'GEMINI.md'],
  readEnvironment: readModelEnvironment,
  readSecret: (_config, _input, snapshot) => snapshot?.resolved.GEMINI_API_KEY ?? '',
  describe: (config, snapshot) => ({
    fields: [...antigravityFields(config), ...modelConnectionFields(snapshot)],
    warnings: [
      ...modelEnvironmentWarnings(config.modelProvider, snapshot),
      ...[antigravitySelectionWarning(config)].filter((value): value is string => !!value),
    ],
  }),
  advancedWarnings: () => Promise.resolve([]),
  async prepare(config, input, snapshot, services) {
    // nativeModelId 只由下面按原生目录解析得出，不受请求内容影响。
    const { nativeModelId: _ignored, ...changes } = input;
    const connection = antigravityConnectionChanges(changes, config, snapshot);
    validateUrl(connection.baseUrl);
    const native = await antigravitySelectionChanges(
      config,
      nativeModelChanges(connection, snapshot),
      services.modelCatalog ?? nativeAntigravityModels,
    );
    return { changes: native, connection: prepareModelConnection(connection, services.environment, snapshot) };
  },
  launchNote:
    'Gemini API 密钥须配合原生 settings.json 的 modelProvider="gemini"；ADC 使用 AGY_ADC_AUTH=true。保存用于新启动的 CLI。',
  validateVariable(name, value) {
    if (name === 'AGY_ADC_AUTH' && !['true', 'false'].includes(value)) throw new NativeConfigError('invalid_request');
    if ((name === 'HTTPS_PROXY' || name === 'HTTP_PROXY') && !validAntigravityProxy(value))
      throw new NativeConfigError('invalid_request');
  },
};
