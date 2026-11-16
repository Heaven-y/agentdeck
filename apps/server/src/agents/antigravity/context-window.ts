import type { NativeContextWindow } from '@agentdeck/shared/settings';
import { object, string } from '../common/configuration/fields';
import { assertAntigravitySelection, selectedAntigravityModel } from './configuration/identity';
import { withAntigravityDiscoveryProfile } from './discovery-profile';
import { startManagementBackend } from './management-process';
import type { AntigravityModelSettings } from './model-catalog';

type NativeModels = { models: Record<string, unknown>; defaultAgentModelId?: string };
let cached: Promise<NativeModels> | undefined;

/** 只读取原生内置目录；隔离认证和扩展，禁止探测访问模型服务。 */
async function nativeModels(): Promise<NativeModels> {
  cached ??= withAntigravityDiscoveryProfile(
    { modelProvider: 'gemini' },
    {
      ...process.env,
      GEMINI_API_KEY: 'local-context-catalog',
      AGY_ADC_AUTH: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
    },
    async ({ root, gemini, env }) => {
      const backend = await startManagementBackend({ cwd: root, geminiDir: gemini, env });
      try {
        const result = object((await backend.request('GetAvailableModels', {})).response);
        return { models: object(result.models), defaultAgentModelId: string(result.defaultAgentModelId) };
      } finally {
        await backend.close();
      }
    },
  ).catch((error: unknown) => {
    cached = undefined;
    throw error;
  });
  return cached;
}

const windowSize = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

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
