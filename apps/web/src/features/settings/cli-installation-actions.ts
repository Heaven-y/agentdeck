import type { QueryClient } from '@tanstack/react-query';
import type { AgentKind } from '@agentdeck/shared/conversation';
import {
  CLI_INSTALL_RELEASE_TTL_MS,
  CliInstallInputSchema,
  type CliInstallInput,
  type CliInstallationStatus,
  type CliInstallPhase,
} from '@agentdeck/shared/settings';
import { ApiError } from '../../lib/http';
import { useChat } from '../chat/chat-store';
import { conversationBusy, conversationViews } from '../chat/conversations';
import { cliInstallationApi, cliInstallationKey } from './cli-installation-api';

export type Action = CliInstallInput['action'] | 'check';
export type InstallationRequest = { agent: AgentKind; action: Action; snapshot: CliInstallationStatus };
export const installationMutationKey = ['cli-installation-action'] as const;
export const writingPhase = (phase: CliInstallPhase) =>
  ['installing', 'updating', 'repairing', 'verifying'].includes(phase);
export const installationActive = (phase: CliInstallPhase) => phase === 'checking' || writingPhase(phase);
export const workbenchBusy = (agent: AgentKind, chat: ReturnType<typeof useChat.getState>) =>
  conversationViews(chat).some((view) => view.agent === agent && conversationBusy(view));

export function validRelease(status: CliInstallationStatus) {
  if (status.checkedAt === null || !status.latestVersion || status.phase === 'failed') return false;
  const age = Date.now() - status.checkedAt;
  return (
    age >= 0 &&
    age <= CLI_INSTALL_RELEASE_TTL_MS &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(status.latestVersion) &&
    CliInstallInputSchema.shape.revision.safeParse(status.revision).success
  );
}

export function availableAction(status: CliInstallationStatus): CliInstallInput['action'] | undefined {
  if (!status.installed) return status.canInstall ? 'install' : undefined;
  if (status.canRepair) return 'repair';
  if (status.canUpdate && status.updateAvailable && validRelease(status)) return 'update';
}

export function otherCliWriting(client: QueryClient, agent: AgentKind) {
  const pending = client.isMutating({
    mutationKey: installationMutationKey,
    predicate: (mutation) => {
      const input = mutation.state.variables as InstallationRequest;
      return input.agent !== agent && input.action !== 'check';
    },
  });
  if (pending) return true;
  return client
    .getQueriesData<CliInstallationStatus>({ queryKey: ['cli-installation'] })
    .some(([, status]) => status && status.agent !== agent && writingPhase(status.phase));
}

function assertIdle(client: QueryClient, agent: AgentKind) {
  if (workbenchBusy(agent, useChat.getState())) throw new ApiError(409, '', { code: 'agent_busy' });
  if (otherCliWriting(client, agent)) throw new ApiError(409, '', { code: 'installation_busy' });
}

function assertSnapshot(client: QueryClient, input: InstallationRequest) {
  const query = client.getQueryState<CliInstallationStatus>(cliInstallationKey(input.agent));
  if (query?.data !== input.snapshot || query.fetchStatus !== 'idle' || query.isInvalidated)
    throw new ApiError(409, '', { code: 'revision_conflict' });
  if (input.action !== 'check' && query.status === 'error') throw new ApiError(409, '', { code: 'check_required' });
}

async function checkLatest(client: QueryClient, input: InstallationRequest) {
  const checked = await cliInstallationApi.check(input.agent);
  // 查新等待期间，环境重检或另一处读取得到的新状态优先。
  assertSnapshot(client, input);
  if (checked.agent !== input.agent) throw new ApiError(409, '', { code: 'revision_conflict' });
  return client.setQueryData<CliInstallationStatus>(cliInstallationKey(input.agent), checked)!;
}

async function submit(client: QueryClient, current: CliInstallationStatus, action: CliInstallInput['action']) {
  if (!validRelease(current)) throw new ApiError(409, '', { code: 'check_required' });
  if (availableAction(current) !== action || installationActive(current.phase))
    throw new ApiError(409, '', { code: 'revision_conflict' });
  assertIdle(client, current.agent);
  const key = cliInstallationKey(current.agent);
  const accepted = await cliInstallationApi.operate(current.agent, { action, revision: current.revision });
  await client.cancelQueries({ queryKey: key });
  return client.setQueryData<CliInstallationStatus>(key, accepted)!;
}

function forgetRelease(client: QueryClient, current: CliInstallationStatus) {
  const key = cliInstallationKey(current.agent);
  if (client.getQueryData(key) !== current || installationActive(current.phase)) return;
  client.setQueryData<CliInstallationStatus>(key, {
    ...current,
    latestVersion: null,
    checkedAt: null,
    canUpdate: false,
    updateAvailable: false,
  });
}

export async function executeCliAction(client: QueryClient, input: InstallationRequest) {
  const { action, agent } = input;
  let current = input.snapshot;
  try {
    assertSnapshot(client, input);
    if (action === 'check') return await checkLatest(client, input);
    if (action !== 'update') {
      assertIdle(client, agent);
      current = await checkLatest(client, input);
      if (current.phase !== 'idle' || availableAction(current) !== action) return current;
    }
    return await submit(client, current, action);
  } catch (error) {
    // 查新或操作失败后撤销旧 release，不回滚并发重读得到的新状态。
    forgetRelease(client, current);
    throw error;
  }
}
