import { ArrowUp, Square } from 'lucide-react';
import { lazy, Suspense, useId, type FormEvent } from 'react';
import { managementPending, useChat } from '../state/chat-store';
import { selectionRestriction } from '../controls/capability-selection';
import { ComposerInput } from './ComposerInput';
import { useResumeSession } from './use-resume-session';
import { resumeArgument } from './resume-command';
import type { AgentCapability } from '@agentdeck/shared/conversation';
import { AgentControls } from '../controls/AgentControls';
import { ComposerStatus } from './ComposerStatus';
import { SessionReferencePreview } from '../references/SessionReferencePreview';
import { ComposerSurface } from './ComposerSurface';
import { AttachmentDropzone, ComposerAttachmentPicker, ComposerAttachments } from './ComposerAttachments';
import { attachmentBlocked } from './attachment-actions';
import { steerAvailable, pendingFollowups, viewQueue } from '../followups/followup-state';
import { FollowupQueue } from '../followups/FollowupQueue';

const ResumeSessionDialog = lazy(() => import('./ResumeSessionDialog'));

function StopAction() {
  const stopping = useChat((s) => s.interruptRequested);
  const interrupt = useChat((s) => s.interrupt);
  return (
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
  );
}

function SubmitActions({ disabled, resume }: { disabled: boolean; resume: boolean }) {
  const running = useChat((s) => s.running);
  const queued = useChat((state) => !viewQueue(state)?.invalid && pendingFollowups(viewQueue(state)).length > 0);
  if (running && !resume) return <StopAction />;
  const label = resume ? '继续会话' : queued ? '加入待发' : '发送';
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="submit"
        aria-label={label}
        title={label}
        className={resume ? 'composer-followup' : 'composer-submit'}
        disabled={!resume && disabled}
      >
        {resume ? label : <ArrowUp aria-hidden className="size-5" />}
      </button>
      {running && <StopAction />}
    </div>
  );
}

function ComposerActions({ disabled, resume }: { disabled: boolean; resume: boolean }) {
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
      {hint && !resume && (
        <p role="status" className="max-w-36 text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
      <SubmitActions disabled={disabled} resume={resume} />
    </>
  );
}

function runningHint(running: boolean, canSteer: boolean) {
  if (running) return canSteer ? 'Enter 加入待发 · Ctrl/Cmd+Enter 引导' : '输入消息，Enter 加入待发';
}
function placeholder(connected: boolean, hint?: string): string {
  return connected ? hint || '描述你想完成的任务…' : '等待连接…';
}
const emptyInput = (text: string, selection: AgentCapability | undefined) => !text.trim() && !selection;
const anyBlocked = (conditions: unknown[]) => conditions.some(Boolean);

/** 运行中 Enter 加入待发；引导只走明确支持的原生通道。 */
export function Composer() {
  const id = useId();
  const resume = useResumeSession();
  const text = useChat((s) => s.draft);
  const attachments = useChat((s) => s.draftAttachments);
  const uploading = useChat((s) => s.attachmentsBusy);
  const setText = useChat((s) => s.setDraft);
  const connected = useChat((s) => s.connection === 'open');
  const loading = useChat((s) => s.loadingHistory);
  const historyError = useChat((s) => s.historyError || s.permissionError);
  const selection = useChat((s) => s.selectedCapability);
  const agent = useChat((s) => s.agent);
  const permissionPending = useChat((s) => s.permissionLoading || s.permissionSaving);
  const sessionId = useChat((s) => s.sessionId);
  const managing = useChat(managementPending);
  const send = useChat((s) => s.send);
  const running = useChat((s) => s.running);
  const canSteer = useChat(steerAvailable);
  const steer = useChat((s) => s.sendFollowup);
  const restriction = selectionRestriction(selection, sessionId, text);
  const resumeSearch = selection ? undefined : resumeArgument(text, agent);
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
  const inputHint = selection?.argumentHint || runningHint(running, canSteer);
  const steerBlocked = anyBlocked([!canSteer, blocked, resumeSearch !== undefined]);

  const submit = (e?: FormEvent<HTMLFormElement>) => {
    if (e && e.target !== e.currentTarget) return;
    e?.preventDefault();
    if (resumeSearch !== undefined) return resume.open(resumeSearch);
    send(text.trim());
  };

  const form = (
    <form onSubmit={submit} className="composer">
      <FollowupQueue focusComposer={() => document.getElementById(id)?.focus()} />
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
            onSteer={steerBlocked ? undefined : () => steer(text.trim(), 'steer')}
            onResume={resume.open}
            busy={busy}
            placeholder={placeholder(connected, inputHint)}
          />
          {restriction && <p className="px-4 text-xs leading-5 text-warning">{restriction}</p>}
          <SessionReferencePreview text={text} />
          <div role="group" aria-label="消息选项" className="composer-toolbar">
            <AgentControls disabled={busy}>
              <ComposerAttachmentPicker disabled={pickerDisabled} />
              <ComposerActions disabled={blocked} resume={resumeSearch !== undefined} />
            </AgentControls>
          </div>
        </ComposerSurface>
      </AttachmentDropzone>
      <ComposerStatus />
    </form>
  );
  return (
    <>
      {form}
      {resume.request && (
        <Suspense fallback={null}>
          <ResumeSessionDialog request={resume.request} choose={resume.choose} close={resume.close} />
        </Suspense>
      )}
    </>
  );
}
