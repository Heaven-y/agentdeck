import { featuresForModel, type AgentKind, type NativeInteractionFeatures } from '@agentdeck/shared/conversation';
import type { AttachmentCapabilityInput } from '../../agents/contracts';
import { nativeVersion, claudeSdkVersion } from '../../agents/common/native-version';
import { discoverClaudeCapabilities } from '../../agents/claude/capabilities';
import { discoverCodexCapabilities } from '../../agents/codex/capabilities';
import { antigravityInputFeatures } from '../../agents/antigravity/acp/features';
export async function inputCapabilities(
  agent: AgentKind,
  input: AttachmentCapabilityInput,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<NativeInteractionFeatures> {
  if (agent === 'antigravity') return antigravityInputFeatures(input, env, signal);
  const cliVersion = await nativeVersion(agent, env, input.workspace.dir, signal);
  const catalog =
    agent === 'claude'
      ? await discoverClaudeCapabilities(input.workspace.dir, {
          env,
          signal,
          cliVersion,
          sdkVersion: await claudeSdkVersion(),
        })
      : await discoverCodexCapabilities(input.workspace.dir, { env, signal, cliVersion });
  const selected = input.model ?? catalog.defaultModel;
  return featuresForModel(
    catalog.features,
    catalog.models.find((model) => model.id === selected),
  );
}
