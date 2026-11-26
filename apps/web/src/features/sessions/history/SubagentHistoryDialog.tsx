import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentKind, SubagentSummary } from '@agentdeck/shared/conversation';
import { GitFork } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DetailDialog } from '../../../ui/DetailDialog';
import { SegmentedControl } from '../../../ui/fields/SegmentedControl';
import { buttonClass, inputClass } from '../../../ui/styles';
import { useChat } from '../../chat/state/chat-store';
import { historyItems, type ChatItem } from '../../conversation/model/conversation-events';
import { ConversationTimeline } from '../../conversation/timeline/ConversationTimeline';
import { TrajectoryView } from '../../conversation/trajectory/TrajectoryView';
import { TrajectoryDetails } from '../../conversation/trajectory/TrajectoryDetails';
import { sessionsApi } from '../api';
import { RecordedConversationSurface } from './RecordedConversationSurface';

type Identity = { workspaceId: string; sessionId: string; agent: AgentKind };
const statuses: Record<SubagentSummary['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知',
};

function SubagentTrajectory({ items }: { items: ChatItem[] }) {
  const [selected, setSelected] = useState<string>();
  const item = items.find((entry) => entry.id === selected);
  return (
    <>
      <TrajectoryView items={items} running={false} selectedItemId={selected} inspect={setSelected} />
      {item && (
        <DetailDialog title="子代理步骤" onClose={() => setSelected(undefined)}>
          <TrajectoryDetails item={item} />
        </DetailDialog>
      )}
    </>
  );
}

function HistoryStatus({
  pending,
  failed,
  empty,
  retry,
}: {
  pending: boolean;
  failed: boolean;
  empty: boolean;
  retry(): void;
}) {
  if (pending)
    return (
      <p role="status" className="m-auto text-sm text-muted-foreground">
        正在读取…
      </p>
    );
  if (failed)
    return (
      <p role="alert" className="text-sm text-destructive-foreground">
        子代理历史读取失败。
        <button type="button" className={buttonClass('ghost')} onClick={retry}>
          重试
        </button>
      </p>
    );
  return empty ? <p className="m-auto text-sm text-muted-foreground">没有可显示的记录</p> : null;
}

function ChildHistory({
  workspaceId,
  sessionId,
  agent,
  agentId,
  parentAgentId,
}: Identity & { agentId: string; parentAgentId?: string }) {
  const [view, setView] = useState<'chat' | 'trajectory'>('chat');
  const history = useInfiniteQuery({
    queryKey: ['subagents', workspaceId, agent, sessionId, 'history', parentAgentId, agentId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) => {
      const result = await sessionsApi.subagents(
        workspaceId,
        sessionId,
        { agentId, parentAgentId, cursor: pageParam },
        { signal, agent },
      );
      if (!('agentId' in result) || result.agentId !== agentId) throw new Error('子代理记录不匹配');
      return result;
    },
    getNextPageParam: (page) => page.nextCursor,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const items = useMemo(() => historyItems(history.data?.pages.flatMap((page) => page.events) ?? []), [history.data]);
  const parent = history.data?.pages.find((page) => page.parentAgentId)?.parentAgentId;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <SegmentedControl<'chat' | 'trajectory'>
          label="子代理视图"
          value={view}
          onChange={setView}
          options={[
            { value: 'chat', label: '对话' },
            { value: 'trajectory', label: '轨迹' },
          ]}
        />
        {parent && <span className="text-xs text-muted-foreground">来自子代理 {parent}</span>}
      </div>
      <HistoryStatus
        pending={history.isPending}
        failed={history.isError}
        empty={items.length === 0}
        retry={() => void history.refetch()}
      />
      <RecordedConversationSurface source={{ workspaceId, agent, sessionId, subagentId: agentId }}>
        {items.length > 0 &&
          (view === 'chat' ? (
            <ConversationTimeline items={items} running={false} />
          ) : (
            <SubagentTrajectory items={items} />
          ))}
      </RecordedConversationSurface>
      {history.hasNextPage && (
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? '正在读取…' : '继续加载'}
        </button>
      )}
    </div>
  );
}

function AgentSelection({
  ids,
  summaries,
  agentId,
  select,
  enter,
}: {
  ids: string[];
  summaries: SubagentSummary[];
  agentId: string;
  select(id: string): void;
  enter(): void;
}) {
  const summary = summaries.find((entry) => entry.agentId === agentId);
  return (
    <>
      <label className="flex shrink-0 items-center gap-2 text-sm">
        子代理
        <select
          aria-label="选择子代理"
          className={`${inputClass} min-w-0 flex-1`}
          value={agentId}
          onChange={(event) => select(event.target.value)}
        >
          {ids.map((id, index) => (
            <option key={id} value={id}>
              {summaries.find((entry) => entry.agentId === id)?.name ?? `子代理 ${index + 1}`} · {id}
            </option>
          ))}
        </select>
      </label>
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{statuses[summary?.status ?? 'unknown']}</span>
        {summary?.role && <span className="min-w-0 break-words">{summary.role}</span>}
        <button type="button" className={`${buttonClass('ghost')} ml-auto text-xs`} onClick={enter}>
          查看其子代理
        </button>
      </div>
      {summary?.usage && (
        <p className="text-xs text-muted-foreground">
          {summary.usage.generations} 次生成
          {summary.usage.inputTokens !== undefined && ` · 输入 ${summary.usage.inputTokens.toLocaleString()}`}
          {summary.usage.cachedInputTokens !== undefined &&
            ` · 缓存 ${summary.usage.cachedInputTokens.toLocaleString()}`}
          {summary.usage.outputTokens !== undefined && ` · 输出 ${summary.usage.outputTokens.toLocaleString()}`} tokens
        </p>
      )}
    </>
  );
}
function SubagentDirectoryStatus({
  pending,
  failed,
  empty,
  retry,
}: {
  pending: boolean;
  failed: boolean;
  empty: boolean;
  retry(): void;
}) {
  if (pending)
    return (
      <p role="status" className="m-auto text-sm text-muted-foreground">
        正在读取…
      </p>
    );
  if (failed)
    return (
      <p role="alert" className="text-sm text-destructive-foreground">
        子代理目录读取失败。
        <button className={buttonClass('ghost')} onClick={retry}>
          重试
        </button>
      </p>
    );
  return empty ? <p className="m-auto text-sm text-muted-foreground">这条会话没有子代理记录</p> : null;
}
function SubagentHistoryDialog({ workspaceId, sessionId, agent, onClose }: Identity & { onClose(): void }) {
  const [selected, setSelected] = useState('');
  const [parents, setParents] = useState<string[]>([]);
  const parentAgentId = parents.at(-1);
  const client = useQueryClient();
  const agents = useQuery({
    queryKey: ['subagents', workspaceId, agent, sessionId, 'list', parentAgentId],
    queryFn: async ({ signal }) => {
      const result = await sessionsApi.subagents(workspaceId, sessionId, { parentAgentId }, { signal, agent });
      if (!('agentIds' in result)) throw new Error('子代理目录格式不正确');
      return { ids: result.agentIds, summaries: result.summaries ?? [] };
    },
    gcTime: 0,
    retry: false,
  });
  const agentId = agents.data?.ids.includes(selected) ? selected : agents.data?.ids[0];
  return (
    <DetailDialog title="子代理历史" onClose={onClose}>
      <div className="flex h-[min(60dvh,640px)] min-h-0 flex-col gap-3">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {parentAgentId && (
            <button
              type="button"
              className={buttonClass('outline')}
              onClick={() => {
                setParents(parents.slice(0, -1));
                setSelected(parentAgentId);
              }}
              aria-label={parents.length === 1 ? '返回主会话子代理' : '返回上级子代理'}
            >
              返回上级
            </button>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={parentAgentId}>
            {parentAgentId ? `来自 ${parentAgentId}` : '主会话的子代理'}
          </span>
          <button
            type="button"
            className={buttonClass('ghost')}
            disabled={agents.isFetching}
            onClick={() => void client.invalidateQueries({ queryKey: ['subagents', workspaceId, agent, sessionId] })}
          >
            刷新
          </button>
        </div>
        <SubagentDirectoryStatus
          pending={agents.isPending}
          failed={agents.isError}
          empty={agents.data?.ids.length === 0}
          retry={() => void agents.refetch()}
        />
        {agentId && (
          <>
            <AgentSelection
              ids={agents.data!.ids}
              summaries={agents.data!.summaries}
              agentId={agentId}
              select={setSelected}
              enter={() => {
                setParents([...parents, agentId]);
                setSelected('');
              }}
            />
            <ChildHistory
              key={`${parentAgentId ?? ''}:${agentId}`}
              workspaceId={workspaceId}
              sessionId={sessionId}
              agent={agent}
              agentId={agentId}
              parentAgentId={parentAgentId}
            />
          </>
        )}
      </div>
    </DetailDialog>
  );
}

function HistoryButton(props: Identity) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`${buttonClass('ghost')} text-xs`} onClick={() => setOpen(true)}>
        <GitFork aria-hidden className="size-3.5" />
        子代理
      </button>
      {open && <SubagentHistoryDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

export function SubagentHistoryButton() {
  const agent = useChat((state) => state.agent);
  const workspaceId = useChat((state) => state.workspaceId);
  const sessionId = useChat((state) => state.sessionId);
  if (!workspaceId || !sessionId) return null;
  return (
    <HistoryButton
      key={`${workspaceId}:${agent}:${sessionId}`}
      workspaceId={workspaceId}
      sessionId={sessionId}
      agent={agent}
    />
  );
}
