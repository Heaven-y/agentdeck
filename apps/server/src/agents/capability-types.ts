import { createHash } from 'node:crypto';
import type {
  AgentCapability,
  AgentKind,
  AgentModel,
  AntigravityConnection,
  NativeInteractionFeatures,
} from '@agentdeck/shared/conversation';

export type NativeInvocation =
  | { kind: 'skill'; name: string; path?: string }
  | { kind: 'command'; name: 'compact' | 'context' | 'review' }
  | { kind: 'acp-command'; name: string };
/** invocation 只在后端持有，不能将客户端路径直接用作技能输入。 */
export type NativeCapabilityCatalog = {
  entries: Array<AgentCapability & { invocation?: NativeInvocation }>;
  models: AgentModel[];
  antigravityConnection?: AntigravityConnection;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  warnings: string[];
  modelWarning?: string;
  commandWarnings?: string[];
  features?: NativeInteractionFeatures;
  collaborationModes?: Array<'default' | 'plan'>;
};
export type CapabilityProvider = (dir: string, signal?: AbortSignal) => Promise<NativeCapabilityCatalog>;
export function capabilityId(agent: AgentKind, ...identity: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([agent, ...identity]))
    .digest('hex');
}
