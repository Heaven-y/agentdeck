import type { NativeContextWindow } from '@agentdeck/shared/settings';
import { object, string } from '../common/configuration/fields';
import { assertAntigravitySelection, selectedAntigravityModel } from './configuration/identity';
import { withAntigravityDiscoveryProfile } from './discovery-profile';
import { startManagementBackend } from './management-process';
import type { AntigravityModelSettings } from './model-catalog';
import { resolveLocalCommand } from '../../platform/process/executable';

type NativeModels = { models: Record<string, unknown>; defaultAgentModelId?: string };
let cached: { key: string; pending: Promise<NativeModels> } | undefined;

export function invalidateAntigravityModelCatalog(): void {
  cached = undefined;
}

function checkedModels(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原生模型目录格式错误');
  const entries = Object.values(value);
  if (!entries.length || entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)))
    throw new Error('原生模型目录格式错误');
  return value as Record<string, unknown>;
}

/** 只读取原生内置目录；隔离认证和扩展，禁止探测访问模型服务。 */
async function nativeModels(originalEnv: NodeJS.ProcessEnv = process.env): Promise<NativeModels> {
  const command = resolveLocalCommand('agy', originalEnv);
  const key = JSON.stringify([command.command, command.args]);
  if (cached?.key === key) return cached.pending;
  const pending = withAntigravityDiscoveryProfile(
    { modelProvider: 'gemini' },
    {
      ...originalEnv,
      GEMINI_API_KEY: 'local-context-catalog',
      AGY_ADC_AUTH: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
    },
    async ({ root, gemini, env }) => {
      const backend = await startManagementBackend({ cwd: root, geminiDir: gemini, env, command });
      try {
        const result = object((await backend.request('GetAvailableModels', {})).response);
        return { models: checkedModels(result.models), defaultAgentModelId: string(result.defaultAgentModelId) };
      } finally {
        await backend.close();
      }
    },
  ).catch((error: unknown) => {
    if (cached?.pending === pending) cached = undefined;
    throw error;
  });
  cached = { key, pending };
  return pending;
}

const windowSize = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** 保留原生目录声明的默认思考档位；不能映射的已知思考模式不静默回退。 */
export async function antigravityDefaultReasoningEffort(
  model: string,
  discover: (env?: NodeJS.ProcessEnv) => Promise<NativeModels> = nativeModels,
  env: NodeJS.ProcessEnv = process.env,
): Promise<'low' | 'medium' | 'high' | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const catalog = await Promise.race([
      discover(env),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('读取原生思考强度超时')), 5000);
      }),
    ]);
    const entry = object(catalog.models[model]);
    const level = entry.thinkingLevel;
    if (level === undefined || level === null) {
      if (entry.supportsThinking === true) throw new Error('未知的原生思考模式');
      return undefined;
    }
    if (level === 1) return 'low';
    if (level === 2) return 'medium';
    if (level === 3) return 'high';
    throw new Error('未知的原生思考强度');
  } finally {
    clearTimeout(timer);
  }
}

function builtinWindow(catalog: NativeModels, model?: string): NativeContextWindow {
  const wanted = model || catalog.defaultAgentModelId;
  const matches = Object.entries(catalog.models).filter(
    ([id, value]) => id === wanted || object(value).displayName === wanted,
  );
  if (matches.length !== 1) return { model };
  const entry = object(matches[0]![1]);
  return { model: model || string(entry.displayName), windowTokens: windowSize(entry.maxTokens) };
}

/** 与启动选择器使用同一份原生设置，窗口按 /context 的总容量口径。 */
export async function antigravityContextWindow(
  settings: AntigravityModelSettings,
  requested?: string,
  discover: () => Promise<NativeModels> = nativeModels,
): Promise<NativeContextWindow> {
  assertAntigravitySelection(settings, requested);
  const custom = settings.modelProvider === 'gemini' ? selectedAntigravityModel(settings, requested) : undefined;
  const model = string(custom?.label) || requested || string(settings.model) || undefined;
  const configured = windowSize(custom?.maxTokens);
  if (configured) return { model, windowTokens: configured };
  // 原生 /context 在自定义条目未设 maxTokens 且尚未生成时报告 Unknown。
  if (custom) return { model };
  return builtinWindow(await discover(), model);
}

/** 启动最多等目录一秒；共享目录查询仍在自身超时预算内完成并清理原生进程。 */
export async function antigravityContextWindowSnapshot(
  settings: AntigravityModelSettings,
  requested?: string,
  read: typeof antigravityContextWindow = antigravityContextWindow,
): Promise<NativeContextWindow> {
  const model = requested || string(settings.model) || undefined;
  const unknown: NativeContextWindow = { model };
  if (settings.modelProvider !== 'gemini' || !model) return unknown;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read(settings, requested),
      new Promise<NativeContextWindow>((resolve) => {
        timer = setTimeout(() => resolve(unknown), 1000);
      }),
    ]);
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
  }
}
