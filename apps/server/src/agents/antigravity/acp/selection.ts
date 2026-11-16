import { NativeSessionIdSchema } from '@agentdeck/shared/conversation';
import type { AgentTurnInput } from '../../contracts';
import type { AntigravityModelSettings } from '../model-catalog';
import { matchingAntigravityModels } from '../configuration/identity';
import { AcpError, object, text, list, type AcpConnection, type AcpRecord } from './types';

export function needsHeadless(
  input: AgentTurnInput,
  settings: AntigravityModelSettings,
  env: NodeJS.ProcessEnv,
): boolean {
  if (settings.modelProvider !== 'gemini' || !env.GEMINI_API_KEY || env.AGY_ADC_AUTH === 'true') return true;
  if (input.permission?.agent === 'antigravity' && input.permission.mode === 'auto') return true;
  // ACP不接受自定义模型映射；不把它的默认Gemini型号冒充用户配置。
  return matchingAntigravityModels({ ...settings, model: input.model ?? settings.model }).length > 0;
}

function optionValues(option: AcpRecord): AcpRecord[] {
  return list(option.options).flatMap((value) => {
    const item = object(value);
    return Array.isArray(item.options) ? item.options.map(object) : [item];
  });
}
export function selectedOption(options: AcpRecord[], id: string, wanted?: string): string {
  const option = options.find((item) => item.id === id);
  const values = option ? optionValues(option) : [];
  if (!wanted) return text(option?.currentValue);
  const matching = values.filter((item) => item.value === wanted || item.name === wanted);
  if (matching.length !== 1) throw new AcpError('selection', '当前 Antigravity ACP 不支持所选参数。');
  return text(matching[0]!.value);
}

function sessionIdentity(response: AcpRecord, expectedId?: string): string {
  const id = text(response.sessionId) || expectedId;
  if (!NativeSessionIdSchema.safeParse(id).success || (expectedId && id !== expectedId))
    throw new AcpError('protocol', 'Antigravity 返回了不同的会话身份，已停止续接。');
  return id!;
}
function requestedOptions(input: AgentTurnInput, settings: AntigravityModelSettings) {
  return {
    model: input.model ?? settings.model,
    thought_level: input.reasoningEffort,
    mode:
      input.permission?.agent === 'antigravity' && input.permission.mode !== 'bypass'
        ? input.permission.mode
        : undefined,
  };
}
function currentValue(options: AcpRecord[], id: string): string {
  return text(options.find((option) => option.id === id)?.currentValue);
}
export async function configureSession(
  client: AcpConnection,
  input: AgentTurnInput,
  setup: { response: AcpRecord; settings: AntigravityModelSettings; signal: AbortSignal },
): Promise<{ id: string; model: string }> {
  const id = sessionIdentity(setup.response, input.sessionId);
  const options = list(setup.response.configOptions).map(object);
  const requested = requestedOptions(input, setup.settings);
  let model = '';
  for (const [configId, wanted] of Object.entries(requested)) {
    const value = selectedOption(options, configId, wanted);
    if (configId === 'model') model = value;
    if (wanted && value !== currentValue(options, configId)) {
      const changed = await client.request(
        'session/set_config_option',
        { sessionId: id, configId, value },
        { signal: setup.signal },
      );
      if (currentValue(list(changed.configOptions).map(object), configId) !== value)
        throw new AcpError('selection', 'Antigravity 未确认所选参数，已停止发送。');
    }
  }
  if (!model) throw new AcpError('selection', 'Antigravity ACP 未确认当前模型。');
  return { id, model };
}
