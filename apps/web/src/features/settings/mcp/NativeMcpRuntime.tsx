import { useEffect, useState } from 'react';
import type {
  NativeManagementContext,
  NativeMcpEntry,
  NativeMcpOperation,
  NativeMcpStatus,
} from '@agentdeck/shared/settings';
import { buttonClass } from '../../../ui/styles';
import { nativeMcpApi } from './native-mcp-api';
import { nativeSettingsError } from '../resources/native-resource-labels';
const states = {
  unchecked: '未检查',
  notStarted: '尚未启动',
  starting: '正在连接',
  connected: '已连接',
  authenticationRequired: '需要授权',
  failed: '连接失败',
  cancelled: '已取消',
  disabled: '已停用',
  unknown: '暂时无法获取状态',
};
type RuntimeButton = { action: string; label: string; cursor?: string };
function instanceButtons(agent: NativeManagementContext['agent'], status: NativeMcpStatus): RuntimeButton[] {
  const buttons: RuntimeButton[] = [];
  if (status.canReconnect)
    buttons.push({ action: 'reconnect', label: agent === 'codex' ? '重载所选会话的 MCP' : '重新连接' });
  if (status.canToggle)
    buttons.push({
      action: status.state === 'disabled' ? 'runtime-enable' : 'runtime-disable',
      label: status.state === 'disabled' ? '在所选会话启用' : '在所选会话停用',
    });
  return buttons;
}
function runtimeLabel(status: NativeMcpStatus | undefined, instanceId?: string) {
  if (!status) return '尚未检查连接';
  if (instanceId) return `${states[status.state]} · 所选会话`;
  return status.state === 'connected' ? '连接检查通过' : `上次检查：${states[status.state]}`;
}
function RuntimeButtons({
  context,
  entry,
  instanceId,
  status,
  busy,
  act,
}: {
  context: NativeManagementContext;
  entry: NativeMcpEntry;
  instanceId?: string;
  status?: NativeMcpStatus;
  busy: boolean;
  act(action: string, cursor?: string): Promise<void>;
}) {
  const buttons: RuntimeButton[] = [{ action: 'check', label: `检查 ${entry.name} 连接` }];
  if (status && instanceId) buttons.push(...instanceButtons(context.agent, status));
  if (context.agent === 'codex' && entry.transport === 'http') buttons.push({ action: 'login', label: '授权登录' });
  if (status?.nextCursor) buttons.push({ action: 'check', label: '读取下一页', cursor: status.nextCursor });
  return (
    <div className="flex flex-wrap gap-2">
      {buttons.map((button) => (
        <button
          key={button.label}
          type="button"
          className={buttonClass('outline')}
          disabled={busy}
          onClick={() => void act(button.action, button.cursor)}
        >
          {button.label}
        </button>
      ))}
    </div>
  );
}
export function McpOAuthCard({ context, initial }: { context: NativeManagementContext; initial: NativeMcpOperation }) {
  const [operation, setOperation] = useState(initial),
    [error, setError] = useState('');
  const waiting = ['running', 'waiting'].includes(operation.state);
  const { agent, projectId } = context;
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const timer = setInterval(() => {
      void nativeMcpApi
        .oauth({ agent, projectId }, operation.id, 'read')
        .then((value) => {
          if (alive) {
            setOperation(value);
            setError('');
          }
        })
        .catch(() => {
          if (alive) setError('暂时读不到授权进度，正在重试。');
        });
    }, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agent, projectId, operation.id, waiting]);
  async function cancel() {
    try {
      setOperation(await nativeMcpApi.oauth(context, operation.id, 'cancel'));
      setError('');
    } catch (reason) {
      setError(nativeSettingsError(reason));
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      <p role="status">
        {operation.name} 授权：
        {
          {
            running: '正在启动',
            waiting: '等待授权完成',
            completed: '已完成',
            failed: '授权失败',
            cancelled: '已取消',
            expired: '已过期',
          }[operation.state]
        }
      </p>
      {operation.authorizationUrl && (
        <a className="underline" href={operation.authorizationUrl} target="_blank" rel="noreferrer noopener">
          打开授权页面
        </a>
      )}
      {waiting && (
        <button type="button" className={buttonClass('outline')} onClick={() => void cancel()}>
          取消授权
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export type McpCheck = { status?: NativeMcpStatus; setStatus(status: NativeMcpStatus): void };

export default function NativeMcpRuntime({
  context,
  entry,
  instanceId,
  onOperation,
  check,
}: {
  context: NativeManagementContext;
  entry: NativeMcpEntry;
  instanceId?: string;
  onOperation?(operation: NativeMcpOperation): void;
  check?: McpCheck;
}) {
  const [localStatus, setLocalStatus] = useState<NativeMcpStatus>(),
    [operation, setOperation] = useState<NativeMcpOperation>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const status = check ? check.status : localStatus;
  async function act(action: string, cursor?: string) {
    setBusy(true);
    setError('');
    try {
      const result = await nativeMcpApi.control(context, {
        id: entry.id,
        revision: entry.revision,
        action,
        instanceId,
        cursor,
      });
      if ('tools' in result) (check?.setStatus ?? setLocalStatus)(result);
      else if (onOperation) onOperation(result);
      else setOperation(result);
    } catch (reason) {
      setError(nativeSettingsError(reason));
    } finally {
      setBusy(false);
    }
  }
  if (context.agent === 'antigravity' || entry.owner) return null;
  return (
    <div className="space-y-2 border-t border-border pt-3 text-sm">
      <p>{runtimeLabel(status, instanceId)}</p>
      <RuntimeButtons context={context} entry={entry} instanceId={instanceId} status={status} busy={busy} act={act} />
      {status && <RuntimeDetails agent={context.agent} status={status} />}
      {operation && <McpOAuthCard key={operation.id} context={context} initial={operation} />}
      {error && (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}

function RuntimeDetails({ agent, status }: { agent: NativeManagementContext['agent']; status: NativeMcpStatus }) {
  return (
    <section aria-label="连接详情" className="break-words text-xs leading-6 text-muted-foreground">
      <h4 className="font-medium text-foreground">连接详情</h4>
      <p>认证：{status.auth}</p>
      {agent === 'claude' && status.state === 'authenticationRequired' && (
        <p>
          在系统终端运行 <code>claude mcp login &lt;服务名&gt;</code>。
        </p>
      )}
      {status.tools.length > 0 && <p>{status.tools.join('、')}</p>}
    </section>
  );
}
