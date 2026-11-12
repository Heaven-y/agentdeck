import { useEffect, useState } from 'react';
import type {
  NativeActionCatalog,
  NativeActionPreview,
  NativeActionResult,
  SessionRef,
} from '@agentdeck/shared/conversation';
import { DetailDialog } from '../../ui/DetailDialog';
import { buttonClass } from '../../ui/styles';
import { ApiError } from '../../lib/http';
import { nativeActionsApi } from './native-actions-api';
import { managementPending, useChat } from './chat-store';
import { refreshSessionLists } from '../sessions/session-queries';
import { NativeActionConfirmation, NativeActionSelection } from './native-action-panels';

export function NativeActionsButton({ disabled = false }: { disabled?: boolean }) {
  const agent = useChat((state) => state.agent),
    workspaceId = useChat((state) => state.workspaceId),
    sessionId = useChat((state) => state.sessionId);
  const busy = useChat((state) => state.running || state.loadingHistory || managementPending(state));
  const [selected, setSelected] = useState<{ workspaceId: string; session: SessionRef }>();
  if (agent === 'antigravity' || !workspaceId || !sessionId) return null;
  return (
    <>
      <button
        type="button"
        className={buttonClass('ghost')}
        disabled={disabled || busy}
        onClick={() => setSelected({ workspaceId, session: { agent, sessionId } })}
      >
        {agent === 'claude' ? '文件回退' : '历史回退'}
      </button>
      {selected && <NativeActionsDialog {...selected} onClose={() => setSelected(undefined)} />}
    </>
  );
}
export function NativeActionsDialog({
  workspaceId,
  session,
  onClose,
}: {
  workspaceId: string;
  session: SessionRef;
  onClose(): void;
}) {
  const title = session.agent === 'claude' ? '原生文件回退' : '原生历史回退';
  const [catalog, setCatalog] = useState<NativeActionCatalog>(),
    [pointId, setPointId] = useState('');
  const [preview, setPreview] = useState<NativeActionPreview>(),
    [result, setResult] = useState<NativeActionResult>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void nativeActionsApi.catalog(workspaceId, session, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setCatalog(value);
          setPointId(value.candidates[0]?.id ?? '');
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setError(message(error));
      },
    );
    return () => controller.abort();
  }, [workspaceId, session]);
  async function prepare() {
    if (!catalog || !pointId) return;
    setBusy(true);
    setError(undefined);
    try {
      setPreview(await nativeActionsApi.preview(workspaceId, session, catalog, pointId));
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    try {
      const value = await nativeActionsApi.execute(workspaceId, session, preview.token);
      setResult(value);
      setPreview(undefined);
      try {
        await refreshAfterAction(workspaceId, session);
      } catch {
        setError('回退结果已保留，列表刷新失败。请重新打开此会话核对。');
      }
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DetailDialog title={title} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          {session.agent === 'claude'
            ? '由 Claude 的文件检查点恢复文件，会话正文保留。未记录的文件不受此操作管理。'
            : '删除选中轮次及之后的原生会话记录，工作区文件保留。此操作不能撤销。'}
        </p>
        {error && (
          <p role="alert" className="text-sm text-warning">
            {error}
          </p>
        )}
        {result ? (
          <p role="status" className="text-sm">
            {result.message}
          </p>
        ) : preview ? (
          <NativeActionConfirmation
            preview={preview}
            busy={busy}
            back={() => setPreview(undefined)}
            execute={() => void execute()}
          />
        ) : catalog ? (
          <NativeActionSelection
            catalog={catalog}
            pointId={pointId}
            setPointId={setPointId}
            busy={busy}
            prepare={() => void prepare()}
          />
        ) : (
          !error && (
            <p role="status" className="text-sm">
              正在读取原生回退位置…
            </p>
          )
        )}
      </div>
    </DetailDialog>
  );
}
function message(error: unknown): string {
  return error instanceof ApiError ? error.message : '原生操作未完成，请重新读取状态后核对。';
}

async function refreshAfterAction(workspaceId: string, session: SessionRef) {
  await refreshSessionLists(session.agent);
  const current = useChat.getState();
  if (
    current.workspaceId === workspaceId &&
    current.agent === session.agent &&
    current.sessionId === session.sessionId &&
    !current.running
  )
    await current.openSession(session, { preserveDraft: true });
}
