import { Popover, PopoverDisclosure, usePopoverStore } from '@ariakit/react';
import { ChevronDown, Clock3, Gauge } from 'lucide-react';
import type { ChatItem } from '../../conversation/model/conversation-events';
import { averageTokenRate, finiteCount, formatDuration, tokenFields } from '../../conversation/model/chat-metrics';
import { ContextStatus } from '../models/ContextStatus';
import { StatisticsLine } from '../../conversation/timeline/StatisticsLine';
import { useChat } from '../state/chat-store';
import { popoverClass } from '../../../ui/styles';

type StatisticsItem = Extract<ChatItem, { kind: 'statistics' }>;

/** 只读当前用户轮次，不将旧值归到本轮。 */
export function latestComposerStatistics(
  items: ChatItem[],
  running: boolean,
  leadingFragment = false,
): StatisticsItem | undefined {
  if (running) return;
  const start = items.findLastIndex((item) => item.kind === 'user');
  if (leadingFragment && start < 0) return;
  return statisticsForTurn(items.slice(start + 1));
}

function statisticsForTurn(current: ChatItem[]): StatisticsItem | undefined {
  const statistics = current.filter((item): item is StatisticsItem => item.kind === 'statistics');
  const failed = statistics.some((item) => item.turnFailed || (item.scope === 'turn' && item.isError));
  const status = current.findLast((item) => item.kind === 'turn-status');
  if (status?.kind === 'turn-status') {
    if (failed || !status.completedReplyStepId) return;
    return statistics.findLast((item) => item.scope === 'step' && item.nativeId === status.completedReplyStepId);
  }
  const latest = statistics.findLast((item) => item.scope === 'turn') ?? statistics.at(-1);
  return latest && failed ? { ...latest, isError: true } : latest;
}

function isTurnInput(item: ChatItem): boolean {
  return item.kind === 'user' && !item.steeringInput;
}

/** 查找同一会话最近的可用速度，跳过当前运行、截断开头和引导输入。 */
function previousStatistics(items: ChatItem[], leadingFragment: boolean) {
  let end = items.findLastIndex(isTurnInput);
  for (let index = end - 1; index >= 0; index--) {
    if (!isTurnInput(items[index]!)) continue;
    const item = latestComposerStatistics(items.slice(index, end), false, leadingFragment);
    if (item && averageTokenRate(item) !== undefined) return item;
    end = index;
  }
}

function statisticsHint(item?: StatisticsItem): string {
  if (!item) return '暂无速度数据';
  if (item.isError) return '本轮未成功完成，不计算平均速度';
  if (averageTokenRate(item) !== undefined)
    return item.scope === 'turn' ? '回合输出 token ÷ 总耗时，包含工具与等待时间' : '模型步骤输出 token ÷ 步骤耗时';
  return '暂无速度数据';
}

function rateLabel(rate: number | undefined, showStep: boolean): string {
  return `${showStep ? '步骤平均 ' : ''}${rate === undefined ? '—' : rate.toFixed(1)} tok/s`;
}

function metrics(item?: StatisticsItem) {
  const rate = item && averageTokenRate(item);
  const duration = finiteCount(item?.durationMs) ? item.durationMs : undefined;
  return { rate, duration, hasDetails: item && (duration !== undefined || tokenFields(item.usage).length > 0) };
}
function TurnStatistics({
  item,
  previous,
  unconfirmed,
}: {
  item?: StatisticsItem;
  previous: boolean;
  unconfirmed: boolean;
}) {
  const popover = usePopoverStore({ placement: 'top-end' });
  const { rate, duration, hasDetails } = metrics(item);
  const hint = statisticsHint(item);
  const detailsLabel = previous ? '最近一次统计详情' : '本轮统计详情';
  return (
    <>
      <PopoverDisclosure
        store={popover}
        render={<button type="button" />}
        aria-label={detailsLabel}
        className="composer-statistic inline-flex min-h-6 max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        title={hint}
      >
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Gauge aria-hidden className="size-3" />
          {previous && <span>最近一次</span>}
          {rateLabel(rate, (previous || unconfirmed) && item?.scope === 'step')}
        </span>
        {duration !== undefined && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock3 aria-hidden className="size-3" /> {formatDuration(duration)}
          </span>
        )}
        <ChevronDown aria-hidden className="size-3" />
      </PopoverDisclosure>
      <Popover
        store={popover}
        portal
        unmountOnHide
        gutter={8}
        aria-label={detailsLabel}
        className={`${popoverClass} max-w-[calc(100vw-32px)] px-4 py-3`}
      >
        {hasDetails && item ? (
          <StatisticsLine statistics={item} />
        ) : (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
      </Popover>
    </>
  );
}

/** 常驻摘要放在输入框外；历史的完整统计仍在轨迹视图中查看。 */
export function ComposerStatus() {
  const items = useChat((state) => state.items);
  const running = useChat((state) => state.running || !!state.pendingClientTurnId);
  const leadingFragment = useChat((state) => !!state.historyPage?.leading);
  const latest = latestComposerStatistics(items, running, leadingFragment);
  const previous =
    !latest || averageTokenRate(latest) === undefined ? previousStatistics(items, leadingFragment) : undefined;
  const displayed = previous ?? latest;
  const start = items.findLastIndex((item) => item.kind === 'user');
  const status = !running && items.slice(start + 1).findLast((item) => item.kind === 'turn-status');
  return (
    <div role="group" aria-label="会话统计" className="composer-status">
      <TurnStatistics key={displayed?.id ?? 'pending'} item={displayed} previous={!!previous} unconfirmed={!!status} />
      <ContextStatus />
    </div>
  );
}
