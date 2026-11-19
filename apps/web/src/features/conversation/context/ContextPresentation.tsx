import type { CompactionState, ContextUsage } from '@agentdeck/shared/conversation';

export type DisplayContextUsage = Omit<ContextUsage, 'usedTokens'> & { usedTokens?: number };

const numberFormat = new Intl.NumberFormat('zh-CN');
const tokens = (value: number) => numberFormat.format(value);
const statusLabels: Record<CompactionState['status'], string> = {
  running: '正在压缩',
  completed: '压缩已完成',
  failed: '压缩失败',
  cancelled: '压缩已中断',
};
function compactionTitle(state: CompactionState, incomplete: boolean): string {
  const title = incomplete ? '压缩结果未确认' : statusLabels[state.status];
  if (!state.trigger) return title;
  return `${title} · ${state.trigger === 'manual' ? '手动' : '自动'}`;
}

export function CompactionStatus({ state, incomplete = false }: { state: CompactionState; incomplete?: boolean }) {
  const warning = incomplete || ['failed', 'cancelled'].includes(state.status);
  return (
    <div className={`space-y-1 text-xs leading-6 ${warning ? 'text-warning' : 'text-muted-foreground'}`}>
      <p>{compactionTitle(state, incomplete)}</p>
      {(state.beforeTokens !== undefined || state.afterTokens !== undefined) && (
        <p>
          压缩前 {state.beforeTokens === undefined ? '—' : tokens(state.beforeTokens)} tokens · 压缩后{' '}
          {state.afterTokens === undefined ? '—' : tokens(state.afterTokens)} tokens
        </p>
      )}
      {state.message && <p className="break-words">{state.message}</p>}
    </div>
  );
}

export function usageSource(usage: DisplayContextUsage): string {
  const labels = {
    claude_estimate: 'Claude 原生估计',
    codex_native: 'Codex 原生统计/估算',
    antigravity_estimate: 'Antigravity 原生估计',
  };
  return labels[usage.source];
}

export function contextPercentage(usage: DisplayContextUsage): number | undefined {
  if (Number.isFinite(usage.percentage) && usage.percentage! >= 0) return usage.percentage;
  if (usage.windowTokens === undefined || !Number.isFinite(usage.windowTokens) || usage.windowTokens <= 0) return;
  return usage.usedTokens !== undefined && Number.isFinite(usage.usedTokens) && usage.usedTokens >= 0
    ? (usage.usedTokens / usage.windowTokens) * 100
    : undefined;
}

/** 用量与窗口分别保留；缺失字段用横线表示，不能用压缩事件代替。 */
export function usageSummary(usage: DisplayContextUsage): string {
  const used = usage.usedTokens === undefined ? undefined : tokens(usage.usedTokens);
  const window = usage.windowTokens === undefined ? undefined : tokens(usage.windowTokens);
  return `${used ?? '—'} / ${window ?? '—'}`;
}
/**
 * 窗口是原生为「当时那个模型」报的值，不是设置页里给别的模型填的窗口；
 * 用量自带模型时以原生报告为准，否则说明当前会话实际在跑的型号。
 */
export function UsageDetails({ usage, model }: { usage: DisplayContextUsage; model?: string }) {
  const percentage = contextPercentage(usage);
  const reported = usage.model || model;
  return (
    <>
      <p>{usageSource(usage)}</p>
      <p>
        用量 {usage.usedTokens === undefined ? '—' : `${tokens(usage.usedTokens)} tokens`}
        {usage.windowTokens !== undefined && ` / 窗口 ${tokens(usage.windowTokens)} tokens`}
        {percentage !== undefined && ` · ${Math.round(percentage * 10) / 10}%`}
      </p>
      {reported && (
        <p className="break-all">
          模型：{reported}
          {usage.windowTokens !== undefined && (
            <span className="text-muted-foreground">（窗口按该模型的原生配置）</span>
          )}
        </p>
      )}
    </>
  );
}
