import {
  nativeFeaturesFor,
  type NativeFeatureAvailability,
  type NativeInteractionFeatures,
} from '@agentdeck/shared/conversation';
import type { AttachmentCapabilityInput } from '../../contracts';
import { readAntigravityModelConfig, type AntigravityModelSettings } from '../models/model-catalog';
import { assertAntigravitySelection } from '../configuration/identity';
import { AntigravityAcpClient } from './client';
import { accountImageRestriction, configureSession, isAccountConnection, needsHeadless } from './selection';
import { ACCOUNT_ACP_AUTH, acpPromptCapabilities, canResumeAcp, hasAcpAuth, initializeAcp } from './handshake';
import type { AcpConnection } from './types';
import { createAgentProbes, createLocalRunner } from '../../common/probe';
import { nativeVersion } from '../../common/native-version';
import { antigravityLoginEnvironment } from '../run/process-environment';

type Probe = { input: AttachmentCapabilityInput; env: NodeJS.ProcessEnv; signal: AbortSignal };

async function headlessFeatures({ input, env, signal }: Probe) {
  const run = createLocalRunner(() => env);
  const probe = await createAgentProbes({
    run: (command, args, options) => {
      signal.throwIfAborted();
      return run(command, args, { ...options, cwd: input.workspace.dir, signal });
    },
  }).probe('antigravity');
  signal.throwIfAborted();
  const features = nativeFeaturesFor('antigravity', {
    runtime: 'antigravity-headless',
    handshake: probe.status === 'available' ? 'confirmed' : 'failed',
    cliVersion: probe.version,
    verifiedFeatures: ['documents'],
    implemented: ['documents'],
  });
  return { features, version: probe.version };
}

/** 选图时只看通道能力，不认证、不打开原生会话；发送时再核对实际模型、权限和续接。 */
async function accountImages({ input, env, signal }: Probe, cliVersion?: string): Promise<NativeFeatureAvailability> {
  const unavailable: NativeFeatureAvailability = {
    available: false,
    support: 'unsupported',
    reason: '当前 AGY 会话不能直接发图。',
  };
  const restriction = accountImageRestriction(input);
  if (restriction) return { ...unavailable, reason: restriction };
  const accountEnv = antigravityLoginEnvironment(env);
  let client: AcpConnection | undefined;
  try {
    if (!cliVersion) return unavailable;
    client = await AntigravityAcpClient.start({ cwd: input.workspace.dir, env: accountEnv });
    const initialized = await initializeAcp(client, signal);
    if (!hasAcpAuth(initialized, ACCOUNT_ACP_AUTH) || (input.sessionId && !canResumeAcp(initialized)))
      return unavailable;
    const image = acpPromptCapabilities(initialized).image === true;
    const features = nativeFeaturesFor('antigravity', {
      runtime: 'antigravity-acp',
      handshake: 'confirmed',
      protocolVersion: 1,
      cliVersion,
      acpCapabilities: { image },
      verifiedFeatures: ['images'],
      implemented: ['images'],
    });
    return features.images.available ? features.images : unavailable;
  } catch {
    signal.throwIfAborted();
    return { available: false, support: 'unknown', reason: '暂时无法使用 AGY 图片发送，可稍后重新选择图片。' };
  } finally {
    await client?.close();
  }
}

async function keyFeatures(
  { input, env, signal }: Probe,
  settings: AntigravityModelSettings,
): Promise<NativeInteractionFeatures> {
  const cliVersion = await nativeVersion('antigravity', env, input.workspace.dir, signal);
  const client = await AntigravityAcpClient.start({
    cwd: input.workspace.dir,
    env,
    bypass: input.permission?.mode === 'bypass',
  });
  let id: string | undefined;
  try {
    const initialized = await initializeAcp(client, signal);
    if (!hasAcpAuth(initialized, 'gemini-api-key')) return nativeFeaturesFor('antigravity');
    await client.request('authenticate', { methodId: 'gemini-api-key' }, { signal });
    // 只检查配置，不续接活动会话；探测空会话立即关闭且不发送 prompt。
    const response = await client.request('session/new', { cwd: input.workspace.dir, mcpServers: [] }, { signal });
    id = typeof response.sessionId === 'string' ? response.sessionId : undefined;
    await configureSession(client, { ...input, sessionId: undefined }, { response, settings, signal });
    const prompt = acpPromptCapabilities(initialized);
    return nativeFeaturesFor('antigravity', {
      runtime: 'antigravity-acp',
      handshake: 'confirmed',
      cliVersion,
      protocolVersion: 1,
      acpCapabilities: { image: prompt.image === true, embeddedContext: prompt.embeddedContext === true },
      verifiedFeatures: ['questions', 'forms'],
      implemented: ['images', 'documents', 'questions', 'forms'],
    });
  } finally {
    if (id) await client.request('session/close', { sessionId: id }, { signal }).catch(() => undefined);
    await client.close();
  }
}

export async function antigravityInputFeatures(
  input: AttachmentCapabilityInput,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<NativeInteractionFeatures> {
  const settings = await readAntigravityModelConfig({ env });
  assertAntigravitySelection(settings, input.model);
  const probe = { input, env, signal };
  if (!needsHeadless(input, settings, env)) return keyFeatures(probe, settings);
  const { features, version } = await headlessFeatures(probe);
  if (input.includeImages !== false && isAccountConnection(settings))
    features.images = await accountImages(probe, version);
  return features;
}
