import { CircleAlert, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Workspace } from '@agentdeck/shared/projects';
import { conversationWidth } from '@agentdeck/shared/settings';
import { buttonClass } from '../../ui/styles';
import { useProductSettings } from '../settings/general/use-product-settings';
import { useChat } from './state/chat-store';
import { Composer } from './composer/Composer';
import { ConversationTimeline } from '../conversation/timeline/ConversationTimeline';
import type { HistoryPagination } from '../conversation/timeline/history-pages';
import { LiveTrajectory } from './timeline/LiveTrajectory';
import { LiveConversationSurface } from './timeline/LiveConversationSurface';
import { RunStatus } from './runtime/RunStatus';
import { FollowupQueue } from './followups/FollowupQueue';
import { RuntimeTasksPanel } from './runtime/RuntimeTasksPanel';

function Banner() {
  const banner = useChat((s) => s.banner);
  const dismiss = useChat((s) => s.dismissBanner);
  if (!banner) return null;
  return (
    <div
      role="alert"
      className="conversation-notice flex items-start gap-2 rounded-xl bg-destructive/8 px-3 py-2 text-[13px]"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 leading-6 break-words text-destructive-foreground">{banner}</span>
      <button
        type="button"
        aria-label="关闭提示"
        className="-m-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={dismiss}
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

function HistoryFailure() {
  const historyError = useChat((s) => s.historyError);
  const permissionError = useChat((s) => s.permissionError);
  const sessionId = useChat((s) => s.sessionId);
  const agent = useChat((s) => s.agent);
  const openSession = useChat((s) => s.openSession);
  const newSession = useChat((s) => s.newSession);

  if (!historyError && !permissionError) return null;
  return (
    <div className="conversation-notice space-y-2 rounded-xl border border-border p-3">
      <p role="alert" className="text-sm text-destructive-foreground">
        {historyError ?? permissionError}
      </p>
      <button
        type="button"
        className={buttonClass('outline')}
        onClick={() =>
          sessionId ? void openSession({ agent, sessionId }, { preserveDraft: true }) : newSession(agent)
        }
      >
        {sessionId ? (historyError ? '重新读取历史' : '重新读取权限') : '开始新会话'}
      </button>
    </div>
  );
}

function RecoveredHistory() {
  const notice = useChat((state) => state.historyNotice);
  const reload = useChat((state) => state.historyReloadNeeded);
  const busy = useChat((state) => state.running || !!state.pendingClientTurnId || state.loadingHistory);
  const sessionId = useChat((state) => state.sessionId);
  const agent = useChat((state) => state.agent);
  const openSession = useChat((state) => state.openSession);
  if (!reload || !notice) return null;
  return (
    <div className="conversation-notice space-y-2 rounded-xl border border-border p-3 text-sm text-muted-foreground">
      <p role="status">{notice}</p>
      {sessionId && (
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={busy}
          onClick={() => void openSession({ agent, sessionId }, { preserveDraft: true })}
        >
          {agent === 'claude' ? '重新读取完整历史' : '重新读取最近记录'}
        </button>
      )}
    </div>
  );
}

function restartHistory() {
  const state = useChat.getState();
  if (state.sessionId)
    void state.openSession({ agent: state.agent, sessionId: state.sessionId }, { preserveDraft: true });
}
function useHistoryPagination(): HistoryPagination | undefined {
  const page = useChat((s) => s.historyPage);
  const error = useChat((s) => s.olderHistoryError);
  const loading = useChat((s) => s.loadingOlderHistory);
  const load = useChat((s) => s.loadOlderHistory);
  const restartDisabled = useChat((s) => s.running || !!s.pendingClientTurnId || s.permissionSaving);
  return page
    ? {
        start: page.start,
        hasOlder: !!page.before,
        loading,
        error,
        load: () => void load(),
        restart: restartHistory,
        restartDisabled,
      }
    : undefined;
}

function EmptyConversation({ hasSession, notice }: { hasSession: boolean; notice?: string }) {
  return (
    <div className="m-auto max-w-lg px-6 py-12 text-center">
      <h2 className="text-[26px] font-medium leading-8 tracking-tight">
        {hasSession ? '继续原生会话' : '从一条消息开始'}
      </h2>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {notice ?? (hasSession ? '原生记录中没有可显示的消息，可以继续发送。' : '描述你想完成的任务。')}
      </p>
    </div>
  );
}

function Messages({ view }: { view: 'chat' | 'trajectory' }) {
  const items = useChat((s) => s.items);
  const running = useChat((s) => s.running);
  const loading = useChat((s) => s.loadingHistory);
  const version = useChat((s) => s.conversationVersion);
  const historyError = useChat((s) => s.historyError);
  const historyNotice = useChat((s) => s.historyNotice);
  const sessionId = useChat((s) => s.sessionId);
  const pagination = useHistoryPagination();
  if (loading) return <p className="m-auto text-sm text-muted-foreground">正在加载会话…</p>;
  if (historyError && items.length === 0) return null;
  if (view === 'trajectory')
    return <LiveTrajectory key={version} items={items} running={running} pagination={pagination} />;
  if (items.length === 0 && !pagination?.hasOlder)
    return <EmptyConversation hasSession={!!sessionId} notice={historyNotice} />;

  return <ConversationTimeline key={version} items={items} running={running} pagination={pagination} />;
}

export function ChatView({ workspace }: { workspace: Workspace }) {
  const version = useChat((s) => s.conversationVersion);
  const view = useChat((s) => s.view);
  const appearance = useProductSettings().data?.settings.appearance;
  // 只在拿到设置后覆盖容器默认值，读不到时沿用 CSS 里的自适应宽度。
  const style = appearance
    ? ({ '--conversation-width': `${conversationWidth(appearance.width)}px` } as CSSProperties)
    : undefined;
  return (
    <section className="conversation" aria-label={`${workspace.name}会话`} style={style}>
      <Banner />
      <HistoryFailure />
      <RecoveredHistory />
      <div key={view} className="conversation-view-content flex min-h-0 flex-1 flex-col">
        <LiveConversationSurface>
          <Messages view={view} />
        </LiveConversationSurface>
      </div>
      <RunStatus />
      <FollowupQueue />
      <RuntimeTasksPanel />
      <Composer key={version} />
    </section>
  );
}
