import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  AGENT_KINDS,
  type AgentKind,
  type SessionPageQuery,
  type SessionSummary,
} from '@agentdeck/shared/conversation';
import { sessionsApi, sessionsKeys } from '../api';
import { ApiError } from '../../../lib/http';

type Options = { scope?: SessionPageQuery['scope']; search?: string; projectId?: string; enabled?: boolean };
// 重新打开页面即开始一次新读取，页面内切项目和搜索继续共享原生页。
const reader = crypto.randomUUID();
export function useSessionSearch(value = '') {
  const [search, setSearch] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(value.trim()), 200);
    return () => clearTimeout(timer);
  }, [value]);
  return search;
}
function useSource(agent: AgentKind, options: Options) {
  const scope = options.scope ?? 'active';
  const client = useQueryClient();
  const key = sessionsKeys.pages(agent, scope, options.search, options.projectId);
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      sessionsApi.page(
        { agent, scope, search: options.search, projectId: options.projectId, cursor: pageParam, reader },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled !== false,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    retry: false,
  });
  const encodedKey = JSON.stringify(key);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.code === 'session_page_expired')
      void client.resetQueries({ queryKey: JSON.parse(encodedKey) as readonly unknown[], exact: true });
  }, [client, encodedKey, query.error]);
  return query;
}
/** 续聊只读一个已选 CLI；防止输入更新时仍能选择上一次搜索的行。 */
export function useAgentSessionPages(agent: AgentKind, projectId: string, value: string) {
  const search = useSessionSearch(value.trim());
  const query = useSource(agent, { scope: 'active', projectId, search });
  const pending = search !== value.trim();
  const sessions = new Map<string, SessionSummary>();
  if (!pending)
    for (const page of query.data?.pages ?? [])
      for (const row of page.items) sessions.set(`${row.agent}:${row.projectId}:${row.sessionId}`, row);
  return {
    sessions: [...sessions.values()],
    loading: pending || query.isPending,
    hasMore: !pending && query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    error: pending ? undefined : query.error?.message,
    more: () => {
      if (!pending && query.hasNextPage && !query.isFetching) void query.fetchNextPage();
    },
    retry: () => {
      if (!query.isError || query.isFetching) return;
      if (query.isFetchNextPageError) void query.fetchNextPage();
      else void query.refetch();
    },
  };
}

/** 固定三来源，项目增加不会再增加原生列表请求；正文始终按会话另读。 */
export function useSessionPages(options: Options = {}) {
  const search = useSessionSearch(options.search);
  const scoped = { ...options, search };
  // 各来源的无限分页查询遵循 React 固定 Hook 顺序。新增 CLI 时由类型检查提示补接查询。
  const byAgent = {
    claude: useSource('claude', scoped),
    codex: useSource('codex', scoped),
    antigravity: useSource('antigravity', scoped),
  } satisfies Record<AgentKind, ReturnType<typeof useSource>>;
  const queries = AGENT_KINDS.map((agent) => byAgent[agent]);
  const rows = new Map<string, SessionSummary>();
  for (const query of queries)
    for (const page of query.data?.pages ?? [])
      for (const row of page.items) rows.set(`${row.agent}:${row.sessionId}`, row);
  return {
    sessions: [...rows.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    loading: options.enabled !== false && queries.some((query) => query.isPending),
    loadingMore: queries.some((query) => query.isFetchingNextPage),
    hasMore: queries.some((query) => query.hasNextPage),
    errors: AGENT_KINDS.flatMap((agent) => {
      const error = byAgent[agent].error;
      return error ? [{ agent, message: error.message }] : [];
    }),
    more: () => {
      for (const query of queries) if (query.hasNextPage && !query.isFetching) void query.fetchNextPage();
    },
    retry: () => {
      for (const query of queries) if (query.isError && !query.isFetching) void query.refetch();
    },
  };
}
