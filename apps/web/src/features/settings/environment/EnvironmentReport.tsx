import { settingsApi, settingsKeys } from '../api';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { AGENT_KINDS } from '@agentdeck/shared/conversation';

import { buttonClass } from '../../../ui/styles';
import { useCancelableRequest } from '../../../lib/use-cancelable-request';
import { agentTool, useEnvironment } from './use-environment';
import { CliInstallationPanel } from '../installation/CliInstallationPanel';
import { cliInstallationKey } from '../installation/cli-installation-api';
import { useChat } from '../../chat/state/chat-store';

export function EnvironmentSummary({ onOpenSettings }: { onOpenSettings(): void }) {
  const query = useEnvironment();
  const agent = useChat((state) => state.agent);
  const tool = agentTool(query.data, agent);
  if (query.isPending || (!query.isError && tool?.available !== false)) return null;
  return (
    <section
      aria-label="启动环境摘要"
      className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border-warning bg-surface-warning px-5 py-1.5 text-xs leading-5 text-warning"
    >
      <CircleAlert aria-hidden className="size-3.5 shrink-0" />
      <p role="status" className="font-medium">
        {query.isError ? '环境读取失败' : `${tool!.name} 暂不可用`}
      </p>
      <button
        type="button"
        className="ml-auto inline-flex min-h-7 items-center rounded-md border border-border-warning bg-background/70 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-background"
        onClick={onOpenSettings}
      >
        查看设置
      </button>
    </section>
  );
}
export function EnvironmentReport({ disabled }: { disabled: boolean }) {
  const query = useEnvironment();
  const request = useCancelableRequest();
  const qc = useQueryClient();
  const check = async () => {
    if (disabled || request.busy) return;
    const report = await request.run(async (signal) => {
      await qc.cancelQueries({ queryKey: settingsKeys.environment });
      return settingsApi.detectEnvironment(signal);
    });
    if (report) {
      qc.setQueryData(settingsKeys.environment, report);
      await Promise.all(AGENT_KINDS.map((agent) => qc.invalidateQueries({ queryKey: cliInstallationKey(agent) })));
    }
  };
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">本机运行环境</h3>
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={request.busy || disabled}
          onClick={() => void check()}
        >
          <RefreshCw aria-hidden className={`size-4 ${request.busy ? 'motion-safe:animate-spin' : ''}`} />
          {request.busy ? '正在检测…' : '重新检测'}
        </button>
      </div>
      {query.isPending && <p role="status">正在读取环境…</p>}
      {(request.error || query.error) && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {request.error ?? query.error?.message}
        </p>
      )}
      {query.data && (
        <p className="text-xs text-muted-foreground">
          检测时间：{new Date(query.data.checkedAt).toLocaleString('zh-CN')}
        </p>
      )}
      <div className="space-y-2">
        {AGENT_KINDS.map((agent) => (
          <CliInstallationPanel
            key={agent}
            agent={agent}
            health={agentTool(query.data, agent)}
            disabled={disabled || request.busy}
          />
        ))}
      </div>
    </section>
  );
}
