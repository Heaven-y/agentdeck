import { useEffect } from 'react';
import { ArrowLeft, Info, Settings2, X } from 'lucide-react';
import type { Workspace } from '@agentdeck/shared/projects';
import { useChat } from '../../features/chat/state/chat-store';
import { AGENT_LABELS } from '../../cli/shared/labels';
import { AgentIcon } from '../../ui/BrandIcons';
import { buttonClass, iconButtonClass } from '../../ui/styles';
import { LiveConversationSurface } from '../../features/chat/timeline/LiveConversationSurface';
import { TrajectoryDetails } from '../../features/conversation/trajectory/TrajectoryDetails';

function StatusField({ running }: { running: boolean }) {
  return (
    <div>
      <dt className="mb-1.5 text-xs text-muted-foreground">状态</dt>
      <dd>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${running ? 'border-interactive/40 bg-surface-selected text-interactive' : 'border-border bg-background/70 text-muted-foreground'}`}
        >
          {running ? '正在运行' : '空闲'}
        </span>
      </dd>
    </div>
  );
}

function SessionOverview({ workspace, settings }: { workspace: Workspace; settings(): void }) {
  const agent = useChat((state) => state.agent);
  const sessionId = useChat((state) => state.sessionId);
  const model = useChat((state) => state.modelOverrides[state.agent]);
  const effort = useChat((state) => state.reasoningEfforts[state.agent]);
  const running = useChat((state) => state.running || !!state.pendingClientTurnId);
  return (
    <>
      <dl className="space-y-4">
        <Field label="工作区" value={workspace.name} />
        <Field label="本地目录" value={workspace.dir} mono />
        <div>
          <dt className="mb-1.5 text-xs text-muted-foreground">CLI</dt>
          <dd className="flex items-center gap-2 text-[13px] font-medium">
            <AgentIcon agent={agent} className="size-4" />
            <span>{AGENT_LABELS[agent]}</span>
          </dd>
        </div>
        <Field label="原生会话 ID" value={sessionId || '发送第一条消息后创建'} mono={!!sessionId} />
        <Field label="模型设置" value={model || '使用 CLI 原生默认'} />
        <Field label="推理强度" value={effort || '使用 CLI 原生默认'} />
        <StatusField running={running} />
      </dl>
      <button type="button" className={buttonClass('outline')} onClick={settings}>
        <Settings2 aria-hidden className="size-4" />
        打开配置
      </button>
    </>
  );
}

/** 右侧按需呈现当前会话上下文；不连接服务器，也不扫描项目文件。 */
export function ConversationSidebar({
  workspace,
  open,
  close,
  settings,
}: {
  workspace?: Workspace;
  open: boolean;
  close(): void;
  settings(): void;
}) {
  const inspected = useChat((state) => state.items.find((item) => item.id === state.inspectedItemId));
  const inspect = useChat((state) => state.inspectItem);
  useEffect(() => {
    if (open || !document.activeElement?.closest('#conversation-sidebar')) return;
    document.querySelector<HTMLButtonElement>('button[aria-controls="conversation-sidebar"]')?.focus();
  }, [open]);
  return (
    <aside
      id="conversation-sidebar"
      aria-label="右侧边栏"
      className="conversation-sidebar flex h-full min-h-0 flex-col bg-background"
      data-open={open || undefined}
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          (event.target instanceof Element && event.target.closest('dialog,[role="dialog"]'))
        )
          return;
        event.preventDefault();
        close();
      }}
    >
      <header className="flex min-h-[58px] shrink-0 items-center gap-2 border-b border-border px-4">
        {inspected ? (
          <button type="button" aria-label="返回会话信息" onClick={() => inspect()} className={iconButtonClass}>
            <ArrowLeft aria-hidden className="size-4" />
          </button>
        ) : (
          <Info aria-hidden className="size-4 text-muted-foreground" />
        )}
        <h2 className="flex-1 text-sm font-semibold tracking-tight">{inspected ? '步骤详情' : '会话信息'}</h2>
        <button type="button" aria-label="收起右侧边栏" onClick={close} className={`${iconButtonClass} -mr-1.5`}>
          <X aria-hidden className="size-4" />
        </button>
      </header>
      <div className="min-h-0 space-y-6 overflow-auto p-5 text-sm">
        {inspected ? (
          <LiveConversationSurface>
            <TrajectoryDetails item={inspected} />
          </LiveConversationSurface>
        ) : workspace ? (
          <SessionOverview workspace={workspace} settings={settings} />
        ) : (
          <p className="leading-6 text-muted-foreground">选择一个工作区或会话，查看当前上下文。</p>
        )}
      </div>
    </aside>
  );
}
function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="mb-1.5 text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`break-words leading-5 ${mono ? 'select-text rounded-lg border border-border/80 bg-background/70 px-2.5 py-1.5 font-mono text-xs [overflow-wrap:anywhere]' : 'text-[13px]'}`}
      >
        {value}
      </dd>
    </div>
  );
}
