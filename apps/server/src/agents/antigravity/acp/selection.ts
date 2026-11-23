import { NativeSessionIdSchema } from '@agentdeck/shared/conversation';
import type { AgentTurnInput } from '../../contracts';
import type { AntigravityModelSettings } from '../models/model-catalog';
import { matchingAntigravityModels } from '../configuration/identity';
import { AcpError, object, text, list, type AcpConnection, type AcpRecord } from './types';

export type AcpSelection = Pick<AgentTurnInput, 'sessionId' | 'model' | 'reasoningEffort' | 'permission'>;

export function isAccountConnection(settings: AntigravityModelSettings): boolean {
  return settings.modelProvider === undefined || settings.modelProvider.trim() === '';
}

export function accountImageRestriction(input: AcpSelection): string | undefined {
  if (input.permission?.agent === 'antigravity' && input.permission.mode === 'auto')
    return 'AGY 自动权限模式不能在这里发图。可切换权限模式或移除图片。';
}

export function needsHeadless(
  input: AcpSelection,
  settings: AntigravityModelSettings,
  env: NodeJS.ProcessEnv,
): boolean {
  if (settings.modelProvider !== 'gemini' || !env.GEMINI_API_KEY || env.AGY_ADC_AUTH === 'true') return true;
  if (input.permission?.agent === 'antigravity' && input.permission.mode === 'auto') return true;
  // ACP 不接受自定义模型映射；不把它的默认 Gemini 型号冒充用户配置。
  return matchingAntigravityModels({ ...settings, model: input.model ?? settings.model }).length > 0;
}

function matchingOptions(options: AcpRecord[], id: string, wanted: string): AcpRecord[] {
  const option = options.find((item) => item.id === id);
  return list(option?.options)
    .flatMap((value) => {
      const item = object(value);
      return Array.isArray(item.options) ? item.options.map(object) : [item];
    })
    .filter((item) => item.value === wanted || item.name === wanted);
}

export function selectedOption(options: AcpRecord[], id: string, wanted?: string): string {
  if (!wanted) return currentValue(options, id);
  const matches = matchingOptions(options, id, wanted);
  if (matches.length !== 1 || !text(matches[0]?.value))
    throw new AcpError('selection', '当前 AGY 不能使用所选模型、强度或权限。');
  return text(matches[0]!.value);
}

export function sessionIdentity(response: AcpRecord, expectedId?: string): string {
  const id = response.sessionId === undefined ? expectedId : text(response.sessionId);
  if (!NativeSessionIdSchema.safeParse(id).success || (expectedId && id !== expectedId))
    throw new AcpError('protocol', 'AGY 返回了另一条会话，本次消息未发送。');
  return id!;
}

/** 官方目录变体在 ACP 中拆为模型和强度；精确匹配的型号优先，不能改用默认模型。 */
function accountVariant(options: AcpRecord[], wanted?: string) {
  if (!wanted || matchingOptions(options, 'model', wanted).length) return;
  const match =
    /^(.*)-(low|medium|high|xhigh|max)$/.exec(wanted) ?? /^(.*) \((low|medium|high|xhigh|max)\)$/i.exec(wanted);
  if (match && matchingOptions(options, 'model', match[1]!).length === 1)
    return { model: match[1]!, effort: match[2]!.toLowerCase() };
}

function requestedMode(permission: AcpSelection['permission']): string | undefined {
  return permission?.agent === 'antigravity' && permission.mode !== 'bypass' ? permission.mode : undefined;
}

function requestedOptions(input: AcpSelection, model: string | undefined, variant?: ReturnType<typeof accountVariant>) {
  return {
    model: variant?.model ?? model,
    thought_level: variant?.effort ?? input.reasoningEffort,
    mode: requestedMode(input.permission),
  };
}

function currentValue(options: AcpRecord[], id: string): string {
  return text(options.find((option) => option.id === id)?.currentValue);
}

async function applyOptions(
  client: AcpConnection,
  session: { id: string; options: AcpRecord[]; signal: AbortSignal },
  requested: ReturnType<typeof requestedOptions>,
): Promise<AcpRecord[]> {
  let { options } = session;
  const chosen = new Map<string, string>();
  for (const [configId, wanted] of Object.entries(requested)) {
    if (!wanted) continue;
    const value = selectedOption(options, configId, wanted);
    chosen.set(configId, value);
    if (value === currentValue(options, configId)) continue;
    const changed = await client.request(
      'session/set_config_option',
      { sessionId: session.id, configId, value },
      { signal: session.signal },
    );
    // 切换模型会重置强度并改变选项；后续选择只能看原生刚返回的目录。
    options = list(changed.configOptions).map(object);
    if (currentValue(options, configId) !== value)
      throw new AcpError('selection', 'AGY 没有应用所选设置，本次消息未发送。');
  }
  if ([...chosen].some(([id, expected]) => currentValue(options, id) !== expected))
    throw new AcpError('selection', 'AGY 没有同时应用所选设置，本次消息未发送。');
  return options;
}

export async function configureSession(
  client: AcpConnection,
  input: AcpSelection,
  setup: { response: AcpRecord; settings: AntigravityModelSettings; signal: AbortSignal; account?: boolean },
): Promise<{ id: string; model: string }> {
  const id = sessionIdentity(setup.response, input.sessionId);
  const options = list(setup.response.configOptions).map(object);
  const wanted = input.model ?? setup.settings.model;
  const variant = setup.account ? accountVariant(options, wanted) : undefined;
  const requested = requestedOptions(input, wanted, variant);
  const chosen = await applyOptions(client, { id, options, signal: setup.signal }, requested);
  const model = currentValue(chosen, 'model');
  if (!model) throw new AcpError('selection', 'AGY 没有返回可用的模型。');
  return { id, model: variant ? `${model}-${variant.effort}` : model };
}
