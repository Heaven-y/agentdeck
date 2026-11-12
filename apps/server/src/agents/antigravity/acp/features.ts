import { nativeFeaturesFor, type NativeInteractionFeatures } from '@agentdeck/shared/conversation';
import type { AgentTurnInput } from '../../contracts';
import { readAntigravityModelSettings } from '../model-catalog';
import { AntigravityAcpClient } from './client';
import { needsHeadless, configureSession } from './selection';
import { object, list } from './types';
import { createAgentProbes, createLocalRunner } from '../../common/probe';
export async function antigravityInputFeatures(
  input: AgentTurnInput,
  env: NodeJS.ProcessEnv,
  cliVersion: string | undefined,
  signal: AbortSignal,
): Promise<NativeInteractionFeatures> {
  const settings = await readAntigravityModelSettings({ env });
  if (needsHeadless(input, settings, env)) {
    signal.throwIfAborted();
    const probe = await createAgentProbes({ run: createLocalRunner(() => env) }).probe('antigravity');
    signal.throwIfAborted();
    return nativeFeaturesFor('antigravity', {
      runtime: 'antigravity-headless',
      handshake: probe.status === 'available' ? 'confirmed' : 'failed',
      cliVersion,
      verifiedFeatures: ['documents'],
      implemented: ['documents'],
    });
  }
  const client = await AntigravityAcpClient.start({
    cwd: input.workspace.dir,
    env,
    bypass: input.permission?.mode === 'bypass',
  });
  let id: string | undefined;
  try {
    const result = await client.request(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: { name: 'agentdeck', title: 'AgentDeck', version: '0.1.1' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      { signal },
    );
    if (
      result.protocolVersion !== 1 ||
      !list(result.authMethods).some((method) => object(method).id === 'gemini-api-key')
    )
      return nativeFeaturesFor('antigravity');
    await client.request('authenticate', { methodId: 'gemini-api-key' }, { signal });
    // 只检查配置，不续接活动会话；探测空会话立即关闭且不发送prompt。
    const response = await client.request('session/new', { cwd: input.workspace.dir, mcpServers: [] }, { signal });
    id = typeof response.sessionId === 'string' ? response.sessionId : undefined;
    await configureSession(client, { ...input, sessionId: undefined }, { response, settings, signal });
    const prompt = object(object(result.agentCapabilities).promptCapabilities);
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
