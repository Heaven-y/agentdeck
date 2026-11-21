import { FolderPlus } from 'lucide-react';
import type { Workspace } from '@agentdeck/shared/projects';
import { ChatView } from '../../features/chat/ChatView';
import { buttonClass } from '../../ui/styles';

/** 主区只负责按状态选择呈现：加载、读取失败、没有项目、有项目。 */
export function SessionPane({
  project,
  pending = false,
  error,
  onAddProject,
}: {
  project?: Workspace;
  pending?: boolean;
  error?: Error | null;
  onAddProject?(): void;
}) {
  if (pending)
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center">
        <p role="status" className="text-sm text-muted-foreground">
          正在加载项目…
        </p>
      </main>
    );
  if (error)
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center px-6">
        <div className="max-w-sm space-y-2 text-center">
          <p role="alert" className="text-sm leading-6 text-destructive-foreground">
            项目列表读取失败：{error.message}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">本机服务恢复后可重新加载界面。</p>
        </div>
      </main>
    );
  if (!project)
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center px-6">
        <div className="flex max-w-sm flex-col items-center gap-3.5 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-surface-subtle text-muted-foreground">
            <FolderPlus aria-hidden className="size-6" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight">选择一个工作区，开始对话</h2>
            <p className="text-[13px] leading-5 text-muted-foreground">
              添加本机项目目录，集中查看并继续原生 CLI 会话。
            </p>
          </div>
          {onAddProject && (
            <button type="button" className={`${buttonClass('primary')} mt-1`} onClick={onAddProject}>
              添加项目目录
            </button>
          )}
        </div>
      </main>
    );
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <ChatView workspace={project} />
    </main>
  );
}
