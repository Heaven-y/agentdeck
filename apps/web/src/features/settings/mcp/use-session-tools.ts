import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { SessionToolsStatus } from '@agentdeck/shared/settings';
import { request } from '../../../lib/http';
import { queryClient } from '../../../lib/query-client';

export const sessionToolsKey = (agent: AgentKind) => ['session-tools', agent] as const;
export function useSessionTools(agent: AgentKind, onChanged?: () => void, reload?: number) {
  const queryKey = sessionToolsKey(agent);
  const url = `/api/session-tools/${agent}`;
  const status = useQuery(
    {
      queryKey,
      queryFn: ({ signal }) => request<SessionToolsStatus>(url, { signal, cache: 'no-store' }),
      staleTime: 0,
    },
    queryClient,
  );
  useEffect(() => {
    if (reload !== undefined) void queryClient.invalidateQueries({ queryKey: sessionToolsKey(agent) });
  }, [agent, reload]);
  const mutation = useMutation(
    {
      mutationFn: async (enabled: boolean) => {
        if (!status.data) throw new Error('请先读取会话引用设置');
        return request<SessionToolsStatus>(url, {
          method: 'PUT',
          body: JSON.stringify({ enabled, revision: status.data.revision }),
        });
      },
      onSettled: async () => {
        // 保存后重启失败也可能已写入配置，两处入口都按实际状态更新。
        await queryClient.invalidateQueries({ queryKey });
        onChanged?.();
      },
    },
    queryClient,
  );
  return { status, mutation };
}
