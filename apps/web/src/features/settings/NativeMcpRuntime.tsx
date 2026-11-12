import { useEffect, useState } from 'react';
import type {
  NativeManagementContext,
  NativeMcpEntry,
  NativeMcpOperation,
  NativeMcpStatus,
} from '@agentdeck/shared/settings';
import { buttonClass } from '../../ui/styles';
import { nativeMcpApi } from './native-mcp-api';
import { nativeSettingsError } from './native-resource-labels';
const states = {
  unchecked: '未检查',
  notStarted: '尚未启动',
  starting: '正在连接',
  connected: '已连接',
  authenticationRequired: '需要授权',
  failed: '连接失败',
  cancelled: '已取消',
  disabled: '运行时已停用',
  unknown: '无法核实运行状态',
};
type RuntimeButton = { action: string; label: string; cursor?: string };
function instanceButtons(agent: NativeManagementContext['agent'], status: NativeMcpStatus): RuntimeButton[] {
  const buttons: RuntimeButton[] = [];
  if (status.canReconnect)
    buttons.push({ action: 'reconnect', label: agent === 'codex' ? '重载实例 MCP 配置' : '重连当前服务' });
  if (status.canToggle)
    buttons.push({
      action: status.state === 'disabled' ? 'runtime-enable' : 'runtime-disable',
      label: status.state === 'disabled' ? '在本实例启用' : '在本实例停用',
    });
  return buttons;
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
  if (context.agent === 'codex' && entry.transport === 'http')
    buttons.push({ action: 'login', label: '原生 OAuth 授权' });
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
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const timer = setInterval(() => {
      void nativeMcpApi
        .oauth(context, operation.id, 'read')
        .then((value) => {
          if (alive) setOperation(value);
        })
        .catch(() => {
          if (alive) setError('无法读取授权进度，请刷新后查看。');
        });
    }, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [context, operation.id, waiting]);
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
            waiting: '等待原生授权完成',
            completed: '原生已确认完成',
            failed: '授权失败',
            cancelled: '已取消',
            expired: '已过期',
          }[operation.state]
        }
      </p>
      {operation.authorizationUrl && (
        <a className="underline" href={operation.authorizationUrl} target="_blank" rel="noreferrer noopener">
          打开原生授权页面
        </a>
      )}
      {waiting && <p className="text-muted-foreground">完成浏览器授权后，仍需等待原生确认。</p>}
      {waiting && (
        <button type="button" className={buttonClass('outline')} onClick={() => void cancel()}>
          取消授权
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export default function NativeMcpRuntime({
  context,
  entry,
  instanceId,
}: {
  context: NativeManagementContext;
  entry: NativeMcpEntry;
  instanceId?: string;
}) {
  const [status, setStatus] = useState<NativeMcpStatus>(),
    [operation, setOperation] = useState<NativeMcpOperation>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
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
      if ('tools' in result) setStatus(result);
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
      <p>
        {status ? states[status.state] : '尚未检查连接'}
        {instanceId ? ' · 当前原生实例的有效同名服务' : ' · 单次显式检查'}
      </p>
      <RuntimeButtons context={context} entry={entry} instanceId={instanceId} status={status} busy={busy} act={act} />
      {context.agent === 'claude' && (
        <p className="text-muted-foreground">
          持久服务 OAuth 登录需要在原生交互终端运行 claude mcp login。对话内的原生授权链接仍在问题卡片处理。
        </p>
      )}
      {status && (
        <p className="break-words text-muted-foreground">
          认证：{status.auth}；工具：{status.tools.join('、') || '未返回工具'}。检查不执行工具。
        </p>
      )}
      {operation && <McpOAuthCard key={operation.id} context={context} initial={operation} />}
      {error && (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
