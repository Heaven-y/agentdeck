import type { AgentKind } from '@agentdeck/shared/conversation';
import { useId, type ReactNode } from 'react';
import { buttonClass } from '../../ui/styles';
import { nativeAgentNames, nativeSettingsError } from './native-resource-labels';
import { useSessionTools } from './use-session-tools';

type State = ReturnType<typeof useSessionTools>;

function AccessSwitch({ state, descriptionId }: { state: State; descriptionId: string }) {
  const { status, mutation } = state;
  const pending = mutation.isPending || status.isFetching;
  const enabled = status.data?.enabled === true;
  const available = status.data?.available === true;
  return (
    <button
      type="button"
      role="switch"
      aria-label="会话引用"
      aria-describedby={descriptionId}
      aria-checked={enabled}
      aria-busy={pending}
      disabled={pending || !available || status.isError}
      className="spotlight-switch shrink-0 disabled:opacity-50"
      onClick={() => mutation.mutate(!enabled)}
    >
      <span />
    </button>
  );
}

function AccessRetry({ state, onChanged }: { state: State; onChanged?: () => void }) {
  const { status, mutation } = state;
  return (
    <button
      type="button"
      className={buttonClass('ghost')}
      disabled={mutation.isPending || status.isFetching}
      onClick={() => {
        mutation.reset();
        void status.refetch().then(() => onChanged?.());
      }}
    >
      重试
    </button>
  );
}

function AccessFeedback({ state, onChanged }: { state: State; onChanged?: () => void }) {
  const { status, mutation } = state;
  const error = mutation.error ?? status.error;
  const message = status.data?.message;
  return (
    <>
      {(status.isPending || mutation.isPending) && (
        <p role="status" className="text-muted-foreground">
          {mutation.isPending ? '正在应用…' : '正在读取状态…'}
        </p>
      )}
      {message && <p className="text-muted-foreground">{message}</p>}
      {error && (
        <p role="alert" className="text-destructive-foreground">
          {nativeSettingsError(error)}
        </p>
      )}
      {(error || message) && <AccessRetry state={state} onChanged={onChanged} />}
    </>
  );
}

export function SessionToolsPanel({
  agent,
  compact = false,
  reload,
  onChanged,
  children,
}: {
  agent: AgentKind;
  compact?: boolean;
  reload?: number;
  onChanged?: () => void;
  children?: ReactNode;
}) {
  const state = useSessionTools(agent, onChanged, reload);
  const descriptionId = useId();
  const name = nativeAgentNames[agent];
  return (
    <section
      aria-label={`${name} 会话引用`}
      className={compact ? 'space-y-2 text-xs' : 'space-y-3 rounded-lg border border-border p-4 text-[13px]'}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="font-medium">会话引用</h4>
            {!compact && <span className="text-xs text-muted-foreground">AgentDeck 提供</span>}
          </div>
          <p id={descriptionId} className="text-muted-foreground">
            {compact
              ? state.status.data?.enabled
                ? `${name} 已可读取引用的会话历史。`
                : `启用后，${name} 可读取引用的会话历史。`
              : `把会话链接发给 ${name}，让它读取历史并接着工作。`}
          </p>
        </div>
        <AccessSwitch state={state} descriptionId={descriptionId} />
      </div>
      <AccessFeedback state={state} onChanged={onChanged} />
      {!compact && (
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-accent">
            工具说明
          </summary>
          <div className="space-y-3 pt-2 leading-5">
            <p>
              启用后，在 {name} 的用户配置中添加 AgentDeck 的只读 MCP 工具 agentdeck_sessions，可读取本机已添加工作区中
              Claude Code、Codex 和 Antigravity 的会话。调用权限沿用 CLI 原生设置。
            </p>
            {children}
          </div>
        </details>
      )}
    </section>
  );
}
