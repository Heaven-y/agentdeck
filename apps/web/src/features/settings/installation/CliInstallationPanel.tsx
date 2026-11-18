import type { AgentKind } from '@agentdeck/shared/conversation';
import type { CliInstallationStatus, CliInstallPhase, EnvironmentTool } from '@agentdeck/shared/settings';
import { RefreshCw } from 'lucide-react';
import { buttonClass } from '../../../ui/styles';
import { availableAction, validRelease } from './cli-installation-actions';
import { AGENT_FULL_NAMES } from '../../../cli/shared/labels';
import { cliInstallationError, useCliInstallation } from './use-cli-installation';

type State = ReturnType<typeof useCliInstallation>;
const progress: Partial<Record<CliInstallPhase, string>> = {
  checking: '正在检查更新…',
  installing: '正在安装…',
  updating: '正在更新…',
  repairing: '正在修复…',
  verifying: '正在验证安装结果…',
};
const pendingText = { check: '正在检查更新…', install: '正在准备安装…', update: '正在更新…', repair: '正在准备修复…' };
const actionLabels = { install: '安装', update: '更新', repair: '修复' };
function needsGuide(status: CliInstallationStatus | undefined, health?: EnvironmentTool) {
  return (
    status &&
    (health?.available === false || status.source === 'unknown' || !status.installed || status.phase === 'failed')
  );
}
function InstallationVersions({ status }: { status: CliInstallationStatus }) {
  return (
    <dl className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 text-xs leading-5">
      <div className="flex min-w-0 gap-2">
        <dt className="shrink-0 text-muted-foreground">当前版本</dt>
        <dd className="break-all">{status.installed ? (status.currentVersion ?? '版本未知') : '未安装'}</dd>
      </div>
      <div className="flex min-w-0 gap-2">
        <dt className="shrink-0 text-muted-foreground">最新版本</dt>
        <dd className="break-all">{status.latestVersion ?? '尚未检查'}</dd>
      </div>
    </dl>
  );
}
function InstallationActions({ state, disabled }: { state: State; disabled: boolean }) {
  const status = state.status.data;
  if (!status) return null;
  const action = availableAction(status);
  const checking = state.pendingAction === 'check' || status.phase === 'checking';
  const blocked = disabled || state.busy || state.status.isFetching;
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass('ghost')} disabled={blocked} onClick={() => state.act('check')}>
        <RefreshCw aria-hidden className={`size-3.5 ${checking ? 'motion-safe:animate-spin' : ''}`} />
        {checking ? '正在检查…' : '检查更新'}
      </button>
      {action && (
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={blocked || state.writesBlocked}
          onClick={() => state.act(action)}
        >
          {actionLabels[action]}
        </button>
      )}
    </div>
  );
}
function showVersionResult(status: CliInstallationStatus, healthy: boolean) {
  return (
    status.installed &&
    status.currentVersion &&
    !status.canRepair &&
    status.source !== 'unknown' &&
    validRelease(status) &&
    (healthy || status.updateAvailable)
  );
}
function InstallationResult({ status, healthy }: { status: CliInstallationStatus; healthy: boolean }) {
  return (
    <>
      {status.message && (
        <p
          role={status.phase === 'failed' ? 'alert' : 'status'}
          className={`break-words text-xs leading-5 ${status.phase === 'failed' ? 'text-destructive-foreground' : 'text-muted-foreground'}`}
        >
          {status.message}
        </p>
      )}
      {showVersionResult(status, healthy) && (
        <p role="status" className={`text-xs ${status.updateAvailable ? 'text-muted-foreground' : 'text-success'}`}>
          {status.updateAvailable ? '有新版本可用' : '已是最新版本'}
        </p>
      )}
    </>
  );
}
function InstallationFeedback({ state, healthy }: { state: State; healthy: boolean }) {
  const status = state.status.data;
  const phase = status?.phase;
  if (state.error)
    return (
      <p role="alert" className="text-xs leading-5 text-destructive-foreground">
        {cliInstallationError(state.error)}
      </p>
    );
  if (state.busy)
    return (
      <div role="status" className="space-y-1 text-xs leading-5 text-muted-foreground">
        <p>{state.pendingAction ? pendingText[state.pendingAction] : phase && progress[phase]}</p>
        {state.pendingAction !== 'check' && phase !== 'checking' && <p>可关闭设置或切换 CLI，任务会继续进行。</p>}
      </div>
    );
  if (!status)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        正在读取安装状态…
      </p>
    );
  return <InstallationResult status={status} healthy={healthy} />;
}

function InstallationHealth({ health }: { health?: EnvironmentTool }) {
  if (!health) return null;
  return (
    <div role={health.available ? 'status' : 'alert'} className="space-y-1 text-xs leading-5">
      <p className={health.available ? 'text-success' : 'text-warning'}>{health.available ? '可用' : '不可用'}</p>
      {health.message && <p className="break-words text-muted-foreground">{health.message}</p>}
    </div>
  );
}

export function CliInstallationPanel({
  agent,
  disabled = false,
  health,
}: {
  agent: AgentKind;
  disabled?: boolean;
  health?: EnvironmentTool;
}) {
  const state = useCliInstallation(agent);
  const status = state.status.data;
  return (
    <section
      aria-label={`${AGENT_FULL_NAMES[agent]} 安装与更新`}
      aria-busy={state.busy || state.status.isPending}
      className="min-w-0 space-y-2.5 rounded-lg border border-border bg-muted/20 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[13px] font-medium">{AGENT_FULL_NAMES[agent]} CLI</h4>
        <InstallationActions state={state} disabled={disabled} />
      </div>
      {status && <InstallationVersions status={status} />}
      <InstallationHealth health={health} />
      <InstallationFeedback state={state} healthy={health?.available !== false} />
      {state.error && (
        <button type="button" className={buttonClass('ghost')} disabled={state.status.isFetching} onClick={state.retry}>
          重试读取
        </button>
      )}
      {state.running && (
        <p className="text-xs leading-5 text-muted-foreground">工作台正在使用此 CLI，结束会话后可安装、更新或修复。</p>
      )}
      {state.otherWriting && (
        <p className="text-xs leading-5 text-muted-foreground">其他 CLI 的维护任务完成后可操作。</p>
      )}
      {needsGuide(status, health) && (
        <a
          className="inline-flex min-h-8 items-center text-xs text-accent underline underline-offset-2"
          href={status?.guideUrl}
          target="_blank"
          rel="noreferrer"
        >
          官方安装指南
        </a>
      )}
    </section>
  );
}
