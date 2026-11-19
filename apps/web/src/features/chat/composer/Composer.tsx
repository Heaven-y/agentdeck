import { ArrowUp, Square } from 'lucide-react';
import { useId, type FormEvent } from 'react';
import { managementPending, useChat } from '../state/chat-store';
import { selectionRestriction } from '../controls/capability-selection';
import { ComposerInput } from './ComposerInput';
import type { AgentCapability } from '@agentdeck/shared/conversation';
import { AgentControls } from '../controls/AgentControls';
import { ComposerStatus } from './ComposerStatus';
import { SessionReferencePreview } from '../references/SessionReferencePreview';
import { ComposerSurface } from './ComposerSurface';
import { AttachmentDropzone, ComposerAttachmentPicker, ComposerAttachments } from './ComposerAttachments';
import { attachmentBlocked } from './attachment-actions';
import { steerAvailable, pendingFollowups, viewQueue } from '../followups/followup-state';

function SubmitActions({ disabled }: { disabled: boolean }) {
  const running = useChat((s) => s.running);
  const stopping = useChat((s) => s.interruptRequested);
  const interrupt = useChat((s) => s.interrupt);
  const canSteer = useChat(steerAvailable);
  const steer = useChat((state) => state.sendFollowup);
  const draft = useChat((state) => state.draft);
  const queued = useChat((state) => !viewQueue(state)?.invalid && pendingFollowups(viewQueue(state)).length > 0);
  return (
    <div className="flex shrink-0 items-center gap-2">
      {running && canSteer && (
        <button
          type="button"
          className="composer-followup"
          disabled={disabled}
          onClick={() => steer(draft.trim(), 'steer')}
        >
          引导本轮
        </button>
      )}
      {running && (
        <button type="submit" aria-label="排队发送" title="排队发送" className="composer-followup" disabled={disabled}>
          排队发送
        </button>
      )}
      {running ? (
        <button
          type="button"
          aria-label={stopping ? '正在停止' : '停止'}
          title={stopping ? '正在停止…' : '停止'}
          className="composer-submit"
          disabled={stopping}
          onClick={interrupt}
        >
          <Square aria-hidden className="size-4" />
          <span className="sr-only">{stopping ? '正在停止…' : '停止'}</span>
        </button>
      ) : (
        <button
          type="submit"
          aria-label={queued ? '排队发送' : '发送'}
          title={queued ? '排队发送' : '发送'}
          className="composer-submit"
          disabled={disabled}
        >
          <ArrowUp aria-hidden className="size-5" />
        </button>
      )}
    </div>
  );
}

function ComposerActions({ disabled }: { disabled: boolean }) {
  const loading = useChat((s) => s.loadingHistory);
  const error = useChat((s) => s.historyError);
  const managing = useChat(managementPending);
  const hint = loading
    ? '正在读取历史，请稍候…'
    : error
      ? '请先重新读取历史'
      : managing
        ? '正在管理当前会话，请稍候…'
        : undefined;
  return (
    <>
      {hint && (
        <p role="status" className="max-w-36 text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
      <SubmitActions disabled={disabled} />
    </>
  );
}

function placeholder(connected: boolean, hint?: string): string {
  return connected ? hint || '描述你想完成的任务…' : '等待连接…';
}
const emptyInput = (text: string, selection: AgentCapability | undefined) => !text.trim() && !selection;
const anyBlocked = (conditions: unknown[]) => conditions.some(Boolean);

/** 运行中仍可编辑；Enter默认排队，引导需即时原生证据且独立点击。 */
export function Composer() {
  const id = useId();
  const text = useChat((s) => s.draft);
  const attachments = useChat((s) => s.draftAttachments);
  const uploading = useChat((s) => s.attachmentsBusy);
  const setText = useChat((s) => s.setDraft);
  const connected = useChat((s) => s.connection === 'open');
  const loading = useChat((s) => s.loadingHistory);
  const historyError = useChat((s) => s.historyError || s.permissionError);
  const selection = useChat((s) => s.selectedCapability);
  const permissionPending = useChat((s) => s.permissionLoading || s.permissionSaving);
  const sessionId = useChat((s) => s.sessionId);
  const managing = useChat(managementPending);
  const send = useChat((s) => s.send);
  const restriction = selectionRestriction(selection, sessionId, text);
  const busy = anyBlocked([loading, managing, permissionPending]);
  const empty = emptyInput(text, selection) && !attachments.length;
  const blocked = anyBlocked([
    !connected,
    empty,
    busy,
    historyError,
    restriction,
    attachmentBlocked({ draftAttachments: attachments, attachmentsBusy: uploading }),
  ]);
  const dropDisabled = anyBlocked([busy, !connected]);
  const pickerDisabled = anyBlocked([dropDisabled, uploading]);

  const submit = (e?: FormEvent<HTMLFormElement>) => {
    if (e && e.target !== e.currentTarget) return;
    e?.preventDefault();
    send(text.trim());
  };

  return (
    <form onSubmit={submit} className="composer">
      <AttachmentDropzone disabled={dropDisabled}>
        <ComposerSurface>
          <ComposerAttachments />
          <label htmlFor={id} className="sr-only">
            输入消息
          </label>
          <ComposerInput
            id={id}
            text={text}
            onChange={setText}
            onSend={submit}
            busy={busy}
            placeholder={placeholder(connected, selection?.argumentHint)}
          />
          {restriction && <p className="px-4 text-xs leading-5 text-warning">{restriction}</p>}
          <SessionReferencePreview text={text} />
          <div role="group" aria-label="消息选项" className="composer-toolbar">
            <AgentControls disabled={busy}>
              <ComposerAttachmentPicker disabled={pickerDisabled} />
              <ComposerActions disabled={blocked} />
            </AgentControls>
          </div>
        </ComposerSurface>
      </AttachmentDropzone>
      <ComposerStatus />
    </form>
  );
}
