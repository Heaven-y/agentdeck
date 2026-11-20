import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Paperclip, X, LoaderCircle } from 'lucide-react';
import { useChat } from '../state/chat-store';
import type { DraftAttachment } from './attachment-actions';
import { AttachmentImage } from '../../conversation/timeline/MessageAttachments';
import { buttonClass } from '../../../ui/styles';
function DraftImage({ item }: { item: DraftAttachment }) {
  const [url] = useState(() => URL.createObjectURL(item.file));
  const failed = useChat((s) => s.attachmentPreviewFailed);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <AttachmentImage src={url} name={item.name} onError={() => failed(item.id)} />;
}
export function ComposerAttachmentPicker({ disabled }: { disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const add = useChat((s) => s.addAttachments);
  return (
    <>
      <input
        ref={input}
        className="hidden"
        type="file"
        multiple
        aria-label="选择图片或文件"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          void add(files);
        }}
      />
      <button
        type="button"
        aria-label="添加图片或文件"
        title="添加图片或文件"
        disabled={disabled}
        className={buttonClass('ghost')}
        onClick={() => input.current?.click()}
      >
        <Paperclip aria-hidden className="size-4" />
      </button>
    </>
  );
}
export function AttachmentDropzone({ children, disabled }: { children: ReactNode; disabled: boolean }) {
  const add = useChat((s) => s.addAttachments);
  return (
    <div
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        if (!disabled) void add(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (!files.length || disabled) return;
        event.preventDefault();
        void add(files);
      }}
    >
      {children}
    </div>
  );
}
function DraftBackups() {
  const backups = useChat((state) => state.draftBackups);
  const restore = useChat((state) => state.restoreDraftBackup),
    discard = useChat((state) => state.discardDraftBackup);
  if (!backups.length) return null;
  return (
    <details className="space-y-2 px-3 pt-3 text-xs" aria-label="保留的草稿">
      <summary className="cursor-pointer text-muted-foreground">保留的草稿 · {backups.length} 条</summary>
      <ul className="max-h-36 space-y-2 overflow-y-auto">
        {backups.map((backup) => (
          <li key={backup.id} className="space-y-1 rounded-lg border border-border p-2">
            <p className="line-clamp-2 break-words">
              {backup.text || '附件草稿'}
              {backup.attachments.length ? ` · ${backup.attachments.length} 个文件` : ''}
            </p>
            <button type="button" className={buttonClass('ghost')} onClick={() => restore(backup.id)}>
              恢复草稿
            </button>
            <button type="button" className={buttonClass('ghost')} onClick={() => discard(backup.id)}>
              放弃此草稿
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
function DraftAttachments() {
  const items = useChat((s) => s.draftAttachments),
    busy = useChat((s) => s.attachmentsBusy),
    remove = useChat((s) => s.removeAttachment),
    retry = useChat((s) => s.retryAttachments);
  const rejected = useChat((s) => s.pendingAttachmentInput?.rejected),
    uncertain = useChat((s) => s.pendingAttachmentInput?.uncertain),
    restore = useChat((s) => s.restoreAttachmentInput),
    discard = useChat((s) => s.discardAttachmentInput);
  if (!items.length && !rejected) return null;
  return (
    <div className="space-y-2 px-3 pt-3" aria-label="待发送附件">
      {rejected && (
        <div className="space-y-1">
          <p role="status" className="text-xs text-muted-foreground">
            {uncertain ? '这条消息可能已发出，请先重新读取会话。' : '恢复时会暂存当前草稿。'}
          </p>
          <button type="button" disabled={busy} className={buttonClass('outline')} onClick={restore}>
            恢复上一条文字与附件
          </button>
          <button type="button" className={buttonClass('ghost')} onClick={discard}>
            放弃暂存输入
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="relative max-w-full space-y-1 rounded-xl border border-border bg-card p-2 pr-8 text-xs"
          >
            {item.asset?.kind === 'image' && !item.error && <DraftImage item={item} />}
            <p className="max-w-52 truncate" title={item.name}>
              {item.name}
            </p>
            {item.error && (
              <p role="alert" className="max-w-52 break-words text-warning">
                {item.error}
              </p>
            )}
            {!item.asset && !item.error && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <LoaderCircle aria-hidden className="size-3 animate-spin" />
                正在准备…
              </span>
            )}
            <button
              type="button"
              aria-label={`移除附件 ${item.name}`}
              className="absolute right-1 top-1 rounded p-1 hover:bg-muted"
              onClick={() => remove(item.id)}
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        ))}
      </div>
      {items.some((item) => item.error && !item.asset) && (
        <button type="button" disabled={busy} className={buttonClass('ghost')} onClick={() => void retry()}>
          重试附件
        </button>
      )}
    </div>
  );
}
export function ComposerAttachments() {
  return (
    <>
      <DraftBackups />
      <DraftAttachments />
    </>
  );
}
