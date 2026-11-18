import { useCallback, useContext, useEffect, useReducer, useSyncExternalStore } from 'react';
import { QueryClientContext, useMutation, useMutationState, useQuery, type QueryClient } from '@tanstack/react-query';
import type { AgentKind } from '@agentdeck/shared/conversation';
import { CLI_INSTALL_RELEASE_TTL_MS } from '@agentdeck/shared/settings';
import { useChat } from '../chat/chat-store';
import {
  executeCliAction,
  installationActive,
  installationMutationKey,
  otherCliWriting,
  workbenchBusy,
  type Action,
  type InstallationRequest,
} from './cli-installation-actions';
import { queryClient } from '../../lib/query-client';
import { ApiError } from '../../lib/http';
import { cliInstallationApi, cliInstallationKey } from './cli-installation-api';
import { observeCliInstallation } from './cli-installation-tracker';

const errorMessages = new Map([
  ['agent_busy', '请结束该 CLI 会话后重试。'],
  ['revision_conflict', '本机安装状态已变化，请重新检查后再试。'],
  ['installation_busy', '已有 CLI 维护任务，请等待完成后再试。'],
  ['check_required', '请先重新检查最新版本，再重试此操作。'],
  ['unsupported', '当前 CLI 不支持此操作，请使用官方安装指南。'],
  ['service_closed', '本机服务正在关闭，请稍后重试。'],
]);

export function cliInstallationError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '本机连接已失效，请刷新页面后重试。';
    const message = errorMessages.get(error.code ?? '');
    if (message) return message;
    if (error.status === 409) return '当前安装状态暂不可操作，请重新检查后再试。';
  }
  return '暂时无法读取或操作 CLI，请重试。';
}

/** 到期时只重绘按钮；联网查新仍由用户触发。 */
function useReleaseExpiry(checkedAt?: number | null) {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (checkedAt == null) return;
    const remaining = checkedAt + CLI_INSTALL_RELEASE_TTL_MS + 1 - Date.now();
    if (remaining > CLI_INSTALL_RELEASE_TTL_MS + 1) return;
    const timer = setTimeout(redraw, Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [checkedAt]);
}

function useWriteGuards(client: QueryClient, agent: AgentKind, readFailed: boolean) {
  const running = useChat((chat) => workbenchBusy(agent, chat));
  const subscribe = useCallback(
    (listener: () => void) => {
      const unwatchQueries = client.getQueryCache().subscribe(listener);
      const unwatchMutations = client.getMutationCache().subscribe(listener);
      return () => {
        unwatchQueries();
        unwatchMutations();
      };
    },
    [client],
  );
  const otherWriting = useSyncExternalStore(subscribe, () => otherCliWriting(client, agent));
  return { running, otherWriting, writesBlocked: running || otherWriting || readFailed };
}

export function useCliInstallation(agent: AgentKind) {
  const client = useContext(QueryClientContext) ?? queryClient;
  const key = cliInstallationKey(agent);
  const mutationKey = [...installationMutationKey, agent];
  const pendingAction = useMutationState<InstallationRequest | undefined>(
    {
      filters: { mutationKey, status: 'pending' },
      select: (entry) => entry.state.variables as InstallationRequest,
    },
    client,
  ).at(-1)?.action;
  const status = useQuery(
    {
      queryKey: key,
      queryFn: ({ signal }) => cliInstallationApi.read(agent, signal),
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: (query) =>
        query.state.status !== 'error' && query.state.data?.phase === 'checking' ? 1000 : false,
    },
    client,
  );
  const guards = useWriteGuards(client, agent, status.isError);
  useReleaseExpiry(status.data?.checkedAt);
  useEffect(() => {
    if (status.isSuccess && status.data) void observeCliInstallation(client, status.data);
  }, [client, status.data, status.dataUpdatedAt, status.isSuccess]);
  const mutation = useMutation(
    {
      mutationKey,
      mutationFn: (input: InstallationRequest) => executeCliAction(client, input),
      onSuccess: (result) => observeCliInstallation(client, result),
      retry: false,
    },
    client,
  );
  const act = (action: Action) => {
    const snapshot = status.data;
    if (!snapshot || client.isMutating({ mutationKey }) || installationActive(snapshot.phase)) return;
    if (action !== 'check' && otherCliWriting(client, agent)) return;
    mutation.mutate({ agent, action, snapshot });
  };
  return {
    status,
    pendingAction,
    ...guards,
    busy: !!pendingAction || (!!status.data && installationActive(status.data.phase)),
    error: (mutation.variables?.agent === agent ? mutation.error : null) ?? status.error,
    act,
    retry() {
      mutation.reset();
      void status.refetch();
    },
  };
}
