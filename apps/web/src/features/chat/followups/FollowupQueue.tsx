import { useState } from 'react';
import { ArrowUp, MessageSquare, SquarePen, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { FOLLOWUP_UNCONFIRMED_REASON, type FollowupItem, type FollowupStatus } from '@agentdeck/shared/conversation';
import { useChat } from '../state/chat-store';
import {
  canReturnToDraft,
  canSteerQueued,
  followupView,
  pendingFollowups,
  type FollowupDraft,
  type LocalFollowupQueue,
} from './followup-state';
import { buttonClass } from '../../../ui/styles';
export const followupStatusLabels: Record<FollowupStatus, string> = {
  queued: '已排队',
  dispatching: '正在投递',
  accepted: '已受理',
  unknown: '受理未确认',
  failed: '未发送',
  cancelled: '已移除',
};
type EntryProps = { item: FollowupItem; queue: LocalFollowupQueue; focusComposer(): void };
const iconAction =
  'grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';

function canRestoreEntry(item: FollowupItem, queue: LocalFollowupQueue) {
  return (
    !!(item.content || queue.drafts[item.clientMessageId]) &&
    (queue.invalid || ['failed', 'unknown', 'cancelled'].includes(item.status))
  );
}
function EntryActions({ item, queue, focusComposer }: EntryProps) {
  const [confirm, setConfirm] = useState(false);
  const cancel = useChat((state) => state.cancelFollowup);
  const edit = useChat((state) => state.editFollowup);
  const steer = useChat((state) => state.steerFollowup);
  const restore = useChat((state) => state.restoreFollowup);
  const canSteer = useChat((state) => canSteerQueued(state, item, queue));
  const canEdit = canReturnToDraft(item, queue);
  const canRemove = !queue.invalid && !['dispatching', 'accepted', 'cancelled'].includes(item.status);
  const id = queue.snapshot.queueId;
  const msg = item.clientMessageId;
  const busy = !!queue.returning;
  const remove = () => {
    if (item.status === 'unknown' && !confirm) setConfirm(true);
    else cancel(id, msg);
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5">
      {canEdit && (
        <button
          type="button"
          className={iconAction}
          disabled={busy}
          aria-label="编辑"
          title="取回到输入框"
          onClick={() => {
            if (edit(id, msg)) focusComposer();
          }}
        >
          <SquarePen aria-hidden className="size-4" />
        </button>
      )}
      {!canEdit && canRestoreEntry(item, queue) && (
        <button type="button" className={buttonClass('ghost')} disabled={busy} onClick={() => restore(id, msg)}>
          恢复到草稿
        </button>
      )}
      {canRemove &&
        (confirm ? (
          <button type="button" className={buttonClass('ghost')} disabled={busy} onClick={remove}>
            确认仅移除记录
          </button>
        ) : (
          <button
            type="button"
            className={iconAction}
            disabled={busy}
            aria-label="移除"
            title="移除待发消息"
            onClick={remove}
          >
            <Trash2 aria-hidden className="size-4" />
          </button>
        ))}
      {canSteer && (
        <button
          type="button"
          className={iconAction}
          disabled={busy}
          aria-label="引导本轮"
          title="引导当前回合"
          onClick={() => steer(id, msg)}
        >
          <ArrowUp aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}
function QueueEntry({ item, queue, focusComposer }: EntryProps) {
  const text = item.content?.text || item.text;
  const attachments = item.content?.attachments?.length;
  const status = entryStatus(item, queue);
  return (
    <li className="rounded-xl border border-border bg-card px-2.5 py-1 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <MessageSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 truncate leading-5" title={text}>
          {text || '附件或原生技能'}
        </p>
        {!!attachments && <span className="shrink-0 text-muted-foreground">{attachments} 个附件</span>}
        {status && (
          <span role="status" className="shrink-0 text-muted-foreground">
            {status}
          </span>
        )}
        <EntryActions key={item.revision} item={item} queue={queue} focusComposer={focusComposer} />
      </div>
      {item.reason && <p className="break-words leading-5 text-warning">{item.reason}</p>}
      {item.status === 'unknown' && (
        <p className="leading-5 text-warning">移除记录不会撤回原生输入；重发前请核对历史。</p>
      )}
    </li>
  );
}
function entryStatus(item: FollowupItem, queue: LocalFollowupQueue) {
  if (queue.returning?.clientMessageId === item.clientMessageId) return '正在取回';
  if (item.status !== 'queued') return followupStatusLabels[item.status];
}
function QueueDraft({ draft, queue }: { draft: FollowupDraft; queue: LocalFollowupQueue }) {
  const restore = useChat((state) => state.restoreFollowup);
  const discard = useChat((state) => state.discardFollowupBackup);
  const id = queue.snapshot.queueId;
  return (
    <li className="space-y-1 rounded-lg border border-border p-2 text-xs">
      <p className="truncate">{draft.text || '附件消息'}</p>
      <p className="text-warning">{draft.error ?? '等待追加消息回执'}</p>
      {(draft.error || queue.invalid) && (
        <div className="flex flex-wrap">
          <button type="button" className={buttonClass('ghost')} onClick={() => restore(id, draft.id)}>
            恢复到草稿
          </button>
          <button type="button" className={buttonClass('ghost')} onClick={() => discard(id, draft.id)}>
            放弃本页备份
          </button>
        </div>
      )}
    </li>
  );
}
function QueueControls({ queue, unresolved }: { queue: LocalFollowupQueue; unresolved: FollowupItem[] }) {
  const clear = useChat((state) => state.clearFollowups),
    resume = useChat((state) => state.resumeFollowups);
  if (queue.invalid || (unresolved.length < 2 && !queue.snapshot.paused)) return null;
  const busy = !!queue.returning;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button
        type="button"
        className={buttonClass('ghost')}
        disabled={busy || !unresolved.some((item) => ['queued', 'failed'].includes(item.status))}
        onClick={() => clear(queue.snapshot.queueId)}
      >
        清空待发
      </button>
      {queue.snapshot.paused && (
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={busy || unresolved.some((item) => ['unknown', 'failed', 'dispatching'].includes(item.status))}
          onClick={() => resume(queue.snapshot.queueId)}
        >
          继续列表
        </button>
      )}
    </div>
  );
}
function QueueReason({ queue }: { queue: LocalFollowupQueue }) {
  const inspect = useChat((state) => state.inspectItem);
  const status = useChat((state) => {
    if (state.running || state.pendingClientTurnId || queue.invalid || !queue.snapshot.paused) return;
    const start = state.items.findLastIndex((item) => item.kind === 'user' && !item.steeringInput);
    return state.items.slice(start + 1).findLast((item) => item.kind === 'turn-status');
  });
  const reason = queue.snapshot.reason;
  if (!reason) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs leading-5 text-muted-foreground">
      <p role="status">{reason}</p>
      {status && reason === FOLLOWUP_UNCONFIRMED_REASON && (
        <button
          type="button"
          className="rounded-md px-1 hover:bg-muted hover:text-foreground"
          aria-label="查看待发暂停原因"
          onClick={() => inspect(status.id)}
        >
          查看原因
        </button>
      )}
    </div>
  );
}
function QueuePanel({ queue, focusComposer }: Omit<EntryProps, 'item'>) {
  const unresolved = pendingFollowups(queue);
  const local = Object.values(queue.drafts).filter(
    (draft) => !queue.snapshot.items.some((item) => item.clientMessageId === draft.id),
  );
  if (!unresolved.length && !local.length && !queue.error) return null;
  return (
    <section
      aria-label={queue.invalid ? '失效列表备份' : '待发列表'}
      className="mb-1 max-h-[min(25dvh,240px)] space-y-1 overflow-y-auto px-1"
    >
      {queue.error && (
        <p role="alert" className="text-xs leading-5 text-warning">
          {queue.error}
        </p>
      )}
      <QueueReason queue={queue} />
      {queue.invalid && <p className="text-xs leading-5 text-warning">列表已失效，保留本页备份。</p>}
      <ul className="space-y-1">
        {unresolved.map((item) => (
          <QueueEntry key={item.clientMessageId} item={item} queue={queue} focusComposer={focusComposer} />
        ))}
        {local.map((draft) => (
          <QueueDraft key={draft.id} draft={draft} queue={queue} />
        ))}
      </ul>
      <QueueControls queue={queue} unresolved={unresolved} />
    </section>
  );
}
export function FollowupQueue({ focusComposer }: { focusComposer(): void }) {
  const queues = useChat(
    useShallow((state) =>
      Object.values(state.followups).filter(
        (queue) => followupView(state, queue.snapshot)?.conversationId === state.conversationId,
      ),
    ),
  );
  return (
    <div className="composer-followups space-y-1 empty:hidden">
      {queues.map((queue) => (
        <QueuePanel key={queue.snapshot.queueId} queue={queue} focusComposer={focusComposer} />
      ))}
    </div>
  );
}
