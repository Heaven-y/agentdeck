import { CircleAlert, History, RefreshCw, ShieldQuestion } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { AgentEvent } from '@agentdeck/shared/conversation';
import { buttonClass } from '../../../ui/styles';
import { historyItems } from '../../conversation/model/conversation-events';
import { TimelineRowView, projectTimeline } from '../../conversation/timeline';
import type { NativeMediaSource } from '../../conversation/media/native-media';
import type { SessionHistoryFailure } from '../queries/use-sessions';
import { RecordedConversationSurface } from './RecordedConversationSurface';

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-12 text-center">{children}</div>;
}

/** 不可回放不是错误，是能力边界：说明来源与原因，不假装空白，也不编造内容。 */
function NotReplayable() {
  return (
    <Centered>
      <div className="max-w-md space-y-2">
        <ShieldQuestion aria-hidden className="mx-auto size-7 text-muted-foreground" />
        <h2 className="text-sm font-medium">此会话的历史无法读取</h2>
        <p className="text-xs leading-5 text-muted-foreground">
          当前原生接口未提供可回放的对话正文。可以继续查看会话摘要，缺失的内容不会被补造。
        </p>
      </div>
    </Centered>
  );
}

function HistoryFailure({ error, onRetry }: { error: SessionHistoryFailure; onRetry?(): void }) {
  return (
    <Centered>
      <div className="max-w-md space-y-3">
        <CircleAlert aria-hidden className="mx-auto size-7 text-destructive" />
        <p role="alert" className="text-sm leading-6 break-words text-destructive-foreground">
          {error.message}
        </p>
        {onRetry && (
          <button type="button" className={buttonClass('outline')} onClick={onRetry}>
            <RefreshCw aria-hidden className="size-4" />
            重新读取
          </button>
        )}
      </div>
    </Centered>
  );
}

function EmptyHistory() {
  return (
    <Centered>
      <div className="max-w-md space-y-2">
        <History aria-hidden className="mx-auto size-7 text-muted-foreground" />
        <h2 className="text-sm font-medium">这条会话没有可显示的历史记录</h2>
        <p className="text-xs leading-5 text-muted-foreground">CLI 的原生存储里还没有消息，或者这一段记录已被清理。</p>
      </div>
    </Centered>
  );
}

function HistoryLoading() {
  return (
    <Centered>
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <History aria-hidden className="size-4" />
        正在读取会话历史…
      </p>
    </Centered>
  );
}

/** 四种非列表状态互斥，先判状态再判列表，避免主组件里堆一串三元。 */
function HistoryBody({
  notReplayable,
  error,
  loading,
  rows,
  expanded,
  setOpen,
  onRetry,
}: {
  notReplayable: boolean;
  error?: SessionHistoryFailure;
  loading: boolean;
  rows: ReturnType<typeof projectTimeline>;
  expanded: ReadonlySet<string>;
  setOpen(id: string, open: boolean): void;
  onRetry?(): void;
}) {
  if (loading) return <HistoryLoading />;
  if (notReplayable)
    return (
      <div className="flex min-h-full flex-col">
        <NotReplayable />
      </div>
    );
  if (error)
    return (
      <div className="flex min-h-full flex-col">
        <HistoryFailure error={error} onRetry={onRetry} />
      </div>
    );
  if (rows.length === 0)
    return (
      <div className="flex min-h-full flex-col">
        <EmptyHistory />
      </div>
    );
  return (
    <div className="flex flex-col py-2">
      {rows.map((row) => (
        <TimelineRowView key={row.id} row={row} expanded={expanded} setOpen={setOpen} />
      ))}
    </div>
  );
}

/**
 * 只读历史时间线：事件流先按既有归并规则整理成 ChatItem，再投影成时间线行，
 * 与实时对话共用同一套 Markdown、工具卡片与读取分组，不接管实时操作。
 */
export function SessionTimeline({
  events,
  source,
  notReplayable = false,
  error,
  loading = false,
  onRetry,
}: {
  events: AgentEvent[];
  source?: NativeMediaSource;
  notReplayable?: boolean;
  error?: SessionHistoryFailure;
  loading?: boolean;
  onRetry?(): void;
}) {
  const rows = useMemo(() => projectTimeline(historyItems(events)), [events]);
  const list = !loading && !notReplayable && !error && rows.length > 0;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const setOpen = useCallback((id: string, open: boolean) => {
    setExpanded((current) => {
      if (current.has(id) === open) return current;
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        role={list ? 'log' : undefined}
        aria-label={list ? '会话历史' : undefined}
      >
        <RecordedConversationSurface source={source}>
          <HistoryBody
            notReplayable={notReplayable}
            error={error}
            loading={loading}
            rows={rows}
            expanded={expanded}
            setOpen={setOpen}
            onRetry={onRetry}
          />
        </RecordedConversationSurface>
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t border-border/70 px-4 py-2 text-xs text-muted-foreground sm:px-6">
        <History aria-hidden className="size-3.5" />
        只读浏览原生会话记录。
      </footer>
    </div>
  );
}
