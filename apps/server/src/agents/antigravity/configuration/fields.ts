import type { ModelSettingField } from '@agentdeck/shared/settings';
import { field, object, string, type ConfigObject } from '../../common/configuration/fields';
import { antigravityModelId, selectedAntigravityModel } from './identity';
export function antigravityFields(config: ConfigObject): ModelSettingField[] {
  const invalidProvider = config.modelProvider !== undefined && typeof config.modelProvider !== 'string';
  const provider = invalidProvider ? 'invalid-native-provider' : string(config.modelProvider).trim();
  const custom = selectedAntigravityModel(config);
  return [
    field('displayName', '模型名称', custom?.label, { group: 'model', placeholder: '与模型 ID 相同' }),
    field('model', '默认模型', custom ? antigravityModelId(custom.modelName) : config.model, {
      group: 'model',
      hint: '选择原生模型或填写服务商的模型 ID；留空使用原生默认。',
    }),
    field('contextWindow', '上下文窗口', custom?.maxTokens, {
      group: 'model',
      placeholder: '由模型决定，如 128K / 1M',
      hint: 'K = 1,000，M = 1,000,000 tokens；总窗口不等于自动压缩触发点。',
    }),
    ...(['planner', 'executor'] as const).map((role) => {
      const value = string(object(config.orchestrator)[role]);
      return field(
        `orchestrator${role === 'planner' ? 'Planner' : 'Executor'}`,
        role === 'planner' ? '规划模型' : '执行模型',
        value,
        {
          group: 'model',
          options: [{ value: '', label: '原生默认' }, ...(value ? [{ value, label: value }] : [])],
        },
      );
    }),
    field('modelProvider', '连接方式', provider, {
      options: [
        { value: '', label: 'Antigravity 账号登录' },
        { value: 'gemini', label: 'Gemini API Key' },
        ...(provider && provider !== 'gemini'
          ? [{ value: provider, label: invalidProvider ? '未知的原生连接配置' : `${provider} · 已有原生值` }]
          : []),
      ],
      hint: '自定义地址使用 Gemini API 协议。',
    }),
  ];
}
