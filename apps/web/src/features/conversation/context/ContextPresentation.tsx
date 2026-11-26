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
/** 所选模型总容量与历史生成的输入预算分别呈现，不将二者当作压缩倒计时。 */
function ContextAmount({ usage }: { usage: DisplayContextUsage }) {
  const percentage = contextPercentage(usage);
  const estimated = usage.source === 'antigravity_estimate';
  return (
    <>
      <p>
        {estimated ? '估计占用' : '用量'} {usage.usedTokens === undefined ? '—' : `${tokens(usage.usedTokens)} tokens`}
        {!estimated && usage.windowTokens !== undefined && ` / 窗口 ${tokens(usage.windowTokens)} tokens`}
        {percentage !== undefined && ` · ${estimated ? '约 ' : ''}${Math.round(percentage * 10) / 10}%`}
      </p>
      {estimated && usage.windowTokens !== undefined && <p>模型总窗口 {tokens(usage.windowTokens)} tokens</p>}
    </>
  );
}

function LastRequestDetails({ lastRequest }: { lastRequest: NonNullable<DisplayContextUsage['lastRequest']> }) {
  return (
    <div className="border-t border-border pt-2">
      <p className="font-medium">最近一次生成</p>
      <p>
        输入 {lastRequest.inputTokens === undefined ? '—' : tokens(lastRequest.inputTokens)} · 缓存读取{' '}
        {lastRequest.cachedInputTokens === undefined ? '—' : tokens(lastRequest.cachedInputTokens)} tokens
      </p>
      {lastRequest.inputBudgetTokens !== undefined && (
        <p>当次输入预算 {tokens(lastRequest.inputBudgetTokens)} tokens</p>
      )}
    </div>
  );
}

export function UsageDetails({ usage, model }: { usage: DisplayContextUsage; model?: string }) {
  const reported = usage.model || model;
  return (
    <>
      <p>{usageSource(usage)}</p>
      <ContextAmount usage={usage} />
      {reported && <p className="break-all">模型：{reported}</p>}
      {usage.lastRequest && <LastRequestDetails lastRequest={usage.lastRequest} />}
    </>
  );
}
