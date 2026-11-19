import { useQuery } from '@tanstack/react-query';
import { modelSettingsApi } from '../../settings/models/model-settings-api';
import { queryClient } from '../../../lib/query-client';
import { useChat } from '../state/chat-store';
import type { ContextUsage } from '@agentdeck/shared/conversation';
import type { NativeContextWindow } from '@agentdeck/shared/settings';

import type { DisplayContextUsage } from '../../conversation/context/ContextPresentation';

function antigravityUsage(
  usage: ContextUsage | null | undefined,
  current: NativeContextWindow | undefined,
  workspaceId?: string,
): DisplayContextUsage | null | undefined {
  // 已登记工作区必须取得所选模型窗口；不能把旧历史的输入预算当当前总容量。
  if (!current) return workspaceId ? { usedTokens: usage?.usedTokens, source: 'antigravity_estimate' } : usage;
  return {
    source: 'antigravity_estimate',
    usedTokens: usage?.usedTokens,
    windowTokens: current.windowTokens,
    model: current.model,
  };
}

/** 计量保留原生估计，窗口与启动的模型选择一致；运行中使用启动时快照。 */
export function useContextWindow(): DisplayContextUsage | null | undefined {
  const agent = useChat((state) => state.agent);
  const model = useChat((state) =>
    (state.running || state.pendingClientTurnId) && state.runningInput
      ? state.runningInput.model || ''
      : state.modelOverrides[state.agent],
  );
  const conversationId = useChat((state) => state.conversationId);
  const workspaceId = useChat((state) => state.workspaceId);
  const running = useChat((state) => state.running || !!state.pendingClientTurnId);
  const activeWindow = useChat((state) => state.contextWindow);
  const usage = useChat((state) => state.contextUsage);
  const configured = useQuery(
    {
      queryKey: ['model-context-window', agent, model, conversationId],
      queryFn: ({ signal }) => modelSettingsApi.contextWindow(agent, model || undefined, signal),
      enabled: agent === 'antigravity' && !!workspaceId && !running,
      staleTime: 0,
      retry: false,
    },
    queryClient,
  );
  if (agent !== 'antigravity') return usage;
  const available = configured.isError ? undefined : configured.data;
  const current = running ? (activeWindow ?? available) : available;
  return antigravityUsage(usage, current, workspaceId);
}
