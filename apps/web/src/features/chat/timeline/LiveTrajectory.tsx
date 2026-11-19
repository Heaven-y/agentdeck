import type { HistoryPagination } from '../../conversation/timeline/history-pages';
import { useChat } from '../state/chat-store';
import type { ChatItem } from '../../conversation/model/conversation-events';
import { TrajectoryView } from '../../conversation/trajectory/TrajectoryView';

export function LiveTrajectory({
  items,
  running,
  pagination,
}: {
  items: ChatItem[];
  running: boolean;
  pagination?: HistoryPagination;
}) {
  const context = useChat((state) => state.contextUsage);
  const selectedItemId = useChat((state) => state.inspectedItemId);
  const inspect = useChat((state) => state.inspectItem);
  return (
    <TrajectoryView
      items={items}
      running={running}
      context={context}
      selectedItemId={selectedItemId}
      inspect={inspect}
      pagination={pagination}
    />
  );
}
