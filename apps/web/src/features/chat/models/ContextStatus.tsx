import { Popover, PopoverDisclosure, usePopoverStore } from '@ariakit/react';
import { ChevronDown } from 'lucide-react';
import type { CompactionState } from '@agentdeck/shared/conversation';
import { useChat } from '../state/chat-store';
import { useContextWindow } from './use-context-window';
import { popoverClass } from '../../../ui/styles';

import {
  CompactionStatus,
  contextPercentage,
  usageSource,
  usageSummary,
  UsageDetails,
  type DisplayContextUsage as ContextUsage,
} from '../../conversation/context/ContextPresentation';

function ContextMeter({ percentage }: { percentage: number }) {
  const display = Math.round(percentage * 10) / 10;
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`上下文占用 ${display}%`}>
      <svg aria-hidden viewBox="0 0 20 20" className="size-4 shrink-0 -rotate-90" fill="none" strokeWidth="2.5">
        <circle cx="10" cy="10" r="7" stroke="currentColor" className="text-border" />
        <circle
          cx="10"
          cy="10"
          r="7"
          pathLength="100"
          stroke="currentColor"
          strokeDasharray={`${Math.min(percentage, 100)} 100`}
          strokeLinecap="round"
          opacity={percentage > 0 ? 1 : 0}
          className={percentage >= 90 ? 'text-warning' : 'text-muted-foreground'}
        />
      </svg>
      <span className="text-xs tabular-nums">{display}%</span>
    </span>
  );
}
const emptyUsageMessage = '暂无上下文用量。';

function usageTitle(usage: ContextUsage | null | undefined, summary: string | undefined) {
  if (!usage) return emptyUsageMessage;
  return summary ? `${usageSource(usage)} · ${summary} tokens` : usageSource(usage);
}

function ContextLabel({
  usage,
  compaction,
  incomplete,
}: {
  usage?: ContextUsage | null;
  compaction?: CompactionState;
  incomplete: boolean;
}) {
  const summary = usage ? usageSummary(usage) : undefined;
  const percentage = usage ? contextPercentage(usage) : undefined;
  return (
    <>
      <span className="whitespace-nowrap">上下文 {summary ?? '—'}</span>
      {percentage !== undefined && <ContextMeter percentage={percentage} />}
      {compaction?.status === 'running' && !incomplete && <span>正在压缩</span>}
      <ChevronDown aria-hidden className="size-3.5 shrink-0" />
    </>
  );
}
/**
 * 位于输入框下方，报告缺失时用横线保留位置；过去的压缩结果只留在详情。
 */
export function ContextStatus() {
  const popover = usePopoverStore({ placement: 'top-end' });
  const usage = useContextWindow();
  const actualModel = useChat((state) => state.actualModel);
  const compaction = useChat((state) => state.compaction);
  const running = useChat((state) => state.running);
  const incomplete = compaction?.status === 'running' && !running;
  const summary = usage ? usageSummary(usage) : undefined;
  return (
    <>
      <PopoverDisclosure
        store={popover}
        render={<button type="button" />}
        aria-label="上下文用量"
        title={usageTitle(usage, summary)}
        className="composer-statistic inline-flex min-h-6 min-w-0 max-w-full flex-wrap items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      >
        <ContextLabel usage={usage} compaction={compaction} incomplete={incomplete} />
      </PopoverDisclosure>
      <Popover
        store={popover}
        portal
        unmountOnHide
        gutter={8}
        aria-label="上下文用量详情"
        className={`${popoverClass} max-h-[min(360px,var(--popover-available-height))] w-80 max-w-[calc(100vw-32px)] space-y-2 overflow-y-auto p-3.5 text-[13px] leading-6 text-muted-foreground`}
      >
        {usage ? <UsageDetails usage={usage} model={actualModel} /> : <p>{emptyUsageMessage}</p>}
        {compaction && compaction.status !== 'completed' && (
          <CompactionStatus state={compaction} incomplete={incomplete} />
        )}
      </Popover>
    </>
  );
}
