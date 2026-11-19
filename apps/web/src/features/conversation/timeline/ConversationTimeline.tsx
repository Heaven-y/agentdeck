import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { buttonClass } from '../../../ui/styles';
import type { ChatItem } from '../model/conversation-events';
import { TimelineRowView, projectTimeline } from '.';
import { UserMessageNavigation } from './UserMessageNavigation';
import { useVisibleMessage } from './use-visible-message';
import { HistoryPageViewport, useHistoryPages, type HistoryPagination } from './history-pages';

/** 动态测量和跟随只交给Virtuoso；展开状态留在列表外，虚拟卸载不丢选择。 */
export function ConversationTimeline({
  items,
  running,
  pagination,
}: {
  items: ChatItem[];
  running: boolean;
  pagination?: HistoryPagination;
}) {
  const rows = useMemo(
    () => projectTimeline(items.filter((item) => item.kind !== 'statistics' && item.kind !== 'turn-status')),
    [items],
  );
  const pages = useHistoryPages(rows, pagination);
  const list = useRef<VirtuosoHandle>(null);
  const atBottom = useRef(true);
  const [bottom, setBottom] = useState(true);
  const visible = useVisibleMessage();
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
  // 只跟随尾部更新；加载更早的页不能因为短列表恰好贴底而抢走阅读位置。
  const tail = items.at(-1);
  useEffect(() => {
    if (atBottom.current) list.current?.autoscrollToBottom();
  }, [tail]);
  return (
    <HistoryPageViewport className="relative min-h-0 flex-1" start={pagination?.start}>
      <Virtuoso
        ref={list}
        {...pages}
        className="h-full"
        data={rows}
        computeItemKey={(_index, row) => row.id}
        defaultItemHeight={120}
        increaseViewportBy={{ top: 300, bottom: 300 }}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        followOutput={(isAtBottom) => (atBottom.current && isAtBottom ? 'auto' : false)}
        scrollerRef={visible.attach}
        rangeChanged={visible.update}
        atBottomStateChange={(value) => {
          atBottom.current = value;
          setBottom(value);
        }}
        atBottomThreshold={32}
        role="log"
        aria-label="对话内容"
        aria-live="polite"
        aria-busy={running}
        itemContent={(index, row) => (
          <TimelineRowView row={row} index={index - pages.firstItemIndex} expanded={expanded} setOpen={setOpen} />
        )}
      />
      <UserMessageNavigation
        rows={rows}
        activeRow={visible.index ?? rows.length - 1}
        jump={(index) => {
          atBottom.current = false;
          setBottom(false);
          visible.setIndex(index);
          list.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' });
        }}
      />
      {!bottom && (
        <button
          type="button"
          className={`${buttonClass('ghost')} conversation-scroll-bottom absolute bottom-4 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap border border-border-strong text-foreground shadow-md`}
          onClick={() => list.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })}
        >
          <ArrowDown aria-hidden className="size-4" />
          回到底部
        </button>
      )}
    </HistoryPageViewport>
  );
}
