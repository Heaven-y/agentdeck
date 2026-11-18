import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { FollowupItem, FollowupStatus } from '@agentdeck/shared/conversation';
import { useChat } from '../state/chat-store';
import type { LocalFollowupQueue } from './followup-state';
import { buttonClass, inputClass } from '../../../ui/styles';
export const followupStatusLabels: Record<FollowupStatus, string> = {
  queued: '已排队',
  dispatching: '正在投递',
  accepted: '已受理',
  unknown: '受理未确认',
  failed: '未发送',
  cancelled: '已移除',
};
type EntryProps = { item: FollowupItem; queue: LocalFollowupQueue };
function QueueEditor({ item, queue, close }: EntryProps & { close(): void }) {
  const [text, setText] = useState(item.content?.text ?? item.text);
  const edit = useChat((state) => state.editFollowup);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (edit(queue.snapshot.queueId, item.clientMessageId, text)) close();
      }}
      className="space-y-2"
    >
      <label className="block">
        编辑待发文字
        <textarea
          aria-label="编辑待发文字"
          className={`${inputClass} mt-1 min-h-20 resize-y`}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <button type="submit" className={buttonClass('outline')}>
          保存修改
        </button>
        <button type="button" className={buttonClass('ghost')} onClick={close}>
          取消编辑
        </button>
      </div>
    </form>
  );
}
function canRestoreEntry({ item, queue }: EntryProps) {
  return (
    !!(item.content || queue.drafts[item.clientMessageId]) &&
    (queue.invalid || ['failed', 'unknown', 'cancelled'].includes(item.status))
  );
}
function EntryActions({ item, queue, edit }: EntryProps & { edit(): void }) {
  const [confirm, setConfirm] = useState(false);
  const cancel = useChat((state) => state.cancelFollowup),
    restore = useChat((state) => state.restoreFollowup);
  const canEdit = !queue.invalid && item.mode === 'queue' && ['queued', 'failed'].includes(item.status);
  const canRemove = !queue.invalid && !['dispatching', 'accepted', 'cancelled'].includes(item.status);
  const canRestore = canRestoreEntry({ item, queue });
  const remove = () => {
    if (item.status === 'unknown' && !confirm) setConfirm(true);
    else cancel(queue.snapshot.queueId, item.clientMessageId);
  };
  return (
    <div className="flex flex-wrap gap-2">
      {canEdit && (
        <button type="button" className={buttonClass('ghost')} onClick={edit}>
          编辑
        </button>
      )}
      {canRestore && (
        <button
          type="button"
          className={buttonClass('ghost')}
          onClick={() => restore(queue.snapshot.queueId, item.clientMessageId)}
        >
          恢复到草稿
        </button>
      )}
      {canRemove && (
        <button type="button" className={buttonClass('ghost')} onClick={remove}>
          {confirm ? '确认仅移除记录' : '移除'}
        </button>
      )}
    </div>
  );
}
function EntryWarnings({ item }: { item: FollowupItem }) {
  return (
    <>
      {!!item.content?.attachments?.length && (
        <p className="text-muted-foreground">{item.content.attachments.length} 个附件</p>
      )}
      {item.reason && <p className="break-words leading-5 text-warning">{item.reason}</p>}
      {item.status === 'unknown' && (
        <p className="leading-5 text-warning">
          请先核对原生历史。移除记录不会撤回原生可能已收到的内容，也不会自动重发。
        </p>
      )}
    </>
  );
}
function QueueEntry({ item, queue }: EntryProps) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="space-y-2 rounded-lg border border-border bg-background p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.mode === 'steer' ? '引导本轮' : '下一轮消息'}</span>
        <span className={item.status === 'unknown' ? 'text-warning' : 'text-muted-foreground'}>
          {followupStatusLabels[item.status]}
        </span>
      </div>
      {editing ? (
        <QueueEditor item={item} queue={queue} close={() => setEditing(false)} />
      ) : (
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words leading-5">
          {item.content?.text || item.text || '附件或原生技能'}
        </p>
      )}
      <EntryWarnings item={item} />
      <EntryActions item={item} queue={queue} edit={() => setEditing(true)} />
    </li>
  );
}
function QueueBody({ queue }: { queue: LocalFollowupQueue }) {
  const clear = useChat((state) => state.clearFollowups),
    resume = useChat((state) => state.resumeFollowups);
  const unresolved = queue.snapshot.items.filter((item) => !['accepted', 'cancelled'].includes(item.status));
  const local = Object.values(queue.drafts).filter(
    (draft) => !queue.snapshot.items.some((item) => item.clientMessageId === draft.id),
  );
  const restore = useChat((state) => state.restoreFollowup);
  const discard = useChat((state) => state.discardFollowupBackup);
  return (
    <div className="mt-2 max-h-[min(40dvh,340px)] space-y-2 overflow-y-auto pr-1">
      {queue.error && (
        <p role="alert" className="text-xs leading-5 text-warning">
          {queue.error}
        </p>
      )}
      {queue.snapshot.reason && (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          {queue.snapshot.reason}
        </p>
      )}
      {queue.invalid && (
        <p className="text-xs leading-5 text-warning">列表已失效，仅保留本页备份；核对历史后可恢复为草稿。</p>
      )}
      <ul className="space-y-2">
        {unresolved.map((item) => (
          <QueueEntry key={item.clientMessageId} item={item} queue={queue} />
        ))}
        {local.map((draft) => (
          <li key={draft.id} className="space-y-2 rounded-lg border border-border p-3 text-xs">
            <p className="break-words">{draft.text || '附件消息'}</p>
            <p className="text-warning">{draft.error ?? '等待追加消息回执'}</p>
            {(draft.error || queue.invalid) && (
              <button
                type="button"
                className={buttonClass('ghost')}
                onClick={() => restore(queue.snapshot.queueId, draft.id)}
              >
                恢复到草稿
              </button>
            )}
            {(draft.error || queue.invalid) && (
              <button
                type="button"
                className={buttonClass('ghost')}
                onClick={() => discard(queue.snapshot.queueId, draft.id)}
              >
                放弃本页备份
              </button>
            )}
          </li>
        ))}
      </ul>
      {!queue.invalid && (
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className={buttonClass('ghost')}
            disabled={!unresolved.some((item) => ['queued', 'failed'].includes(item.status))}
            onClick={() => clear(queue.snapshot.queueId)}
          >
            清空待发
          </button>
          {queue.snapshot.paused && (
            <button
              type="button"
              className={buttonClass('outline')}
              disabled={unresolved.some((item) => ['unknown', 'failed', 'dispatching'].includes(item.status))}
              onClick={() => resume(queue.snapshot.queueId)}
            >
              继续列表
            </button>
          )}
        </div>
      )}
    </div>
  );
}
function QueuePanel({ queue }: { queue: LocalFollowupQueue }) {
  const count =
    queue.snapshot.items.filter((item) => !['accepted', 'cancelled'].includes(item.status)).length +
    Object.values(queue.drafts).filter(
      (draft) => !queue.snapshot.items.some((item) => item.clientMessageId === draft.id),
    ).length;
  if (!count && !queue.error) return null;
  return (
    <details className="rounded-xl border border-border bg-card p-3" aria-label="待发列表">
      <summary className="cursor-pointer text-xs font-medium outline-offset-4">
        {queue.invalid ? '失效列表备份' : '待发列表'} · {count} 条{queue.snapshot.paused ? ' · 已暂停' : ''}
      </summary>
      <QueueBody queue={queue} />
    </details>
  );
}
export function FollowupQueue() {
  const queues = useChat(
    useShallow((state) =>
      Object.values(state.followups).filter(
        (queue) =>
          queue.snapshot.conversationId === state.conversationId &&
          queue.snapshot.workspaceId === state.workspaceId &&
          queue.snapshot.agent === state.agent,
      ),
    ),
  );
  return (
    <div className="space-y-2">
      {queues.map((queue) => (
        <QueuePanel key={queue.snapshot.queueId} queue={queue} />
      ))}
    </div>
  );
}
