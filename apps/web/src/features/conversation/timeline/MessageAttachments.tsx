import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { MessageAttachment } from '@agentdeck/shared/conversation';
import { DetailDialog } from '../../../ui/DetailDialog';
import { useChat } from '../../chat/state/chat-store';
import { attachmentApi } from '../../chat/composer/attachment-api';
export function AttachmentImage({ src, name, onError }: { src: string; name: string; onError?(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={`查看图片 ${name}`}
        onClick={() => setOpen(true)}
        className="block overflow-hidden rounded-lg border border-border bg-muted"
      >
        <img src={src} alt={name} onError={onError} className="h-24 w-32 object-contain" />
      </button>
      {open && (
        <DetailDialog title={name} onClose={() => setOpen(false)}>
          <img src={src} alt={name} className="mx-auto max-h-[65vh] max-w-full object-contain" />
        </DetailDialog>
      )}
    </>
  );
}
function MediaPreview({ attachment }: { attachment: MessageAttachment }) {
  const workspaceId = useChat((s) => s.workspaceId),
    agent = useChat((s) => s.agent),
    conversationId = useChat((s) => s.conversationId),
    sessionId = useChat((s) => s.sessionId);
  const connection = useChat((s) => s.connection);
  const identity = useChat((s) => s.attachmentIdentity)();
  const token = identity?.token,
    instanceId = identity?.instanceId;
  const key = JSON.stringify([workspaceId, agent, conversationId, sessionId, connection, identity?.token, attachment]);
  const [result, setResult] = useState<{ key: string; url?: string; error?: string }>({ key: '' });
  useEffect(() => {
    const abort = new AbortController();
    let created: string | undefined;
    const view = {
      workspaceId,
      agent,
      conversationId,
      sessionId,
      modelOverrides: { claude: '', codex: '', antigravity: '' },
    };
    const read =
      attachment.kind === 'native-image'
        ? attachmentApi.nativeMedia(view, attachment.locator, abort.signal)
        : token && instanceId
          ? attachmentApi.preview(view, { token, instanceId }, attachment, abort.signal)
          : Promise.reject(new Error('请等待连接恢复后查看图片。'));
    void read.then(
      (blob) => {
        if (abort.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setResult({ key, url: created });
      },
      (error) => {
        if (!abort.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : '图片不可读取' });
      },
    );
    return () => {
      abort.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [key, workspaceId, agent, conversationId, sessionId, attachment, token, instanceId]);
  if (result.key !== key) return <p className="text-xs text-muted-foreground">正在读取图片…</p>;
  if (!result.url) return <p className="text-xs text-warning">{result.error}</p>;
  return (
    <AttachmentImage
      src={result.url}
      name={attachment.name}
      onError={() => setResult({ key, error: '图片无法解码，原生记录可能损坏或格式不受支持。' })}
    />
  );
}
export function MessageAttachments({ attachments }: { attachments?: MessageAttachment[] }) {
  if (!attachments?.length) return null;
  return (
    <div aria-label="消息附件" className="mt-2 flex flex-wrap gap-2">
      {attachments.map((attachment, index) => (
        <div
          key={attachment.kind === 'native-image' ? `${attachment.locator.messageId}-${index}` : attachment.id}
          className="min-w-0 max-w-full"
        >
          {attachment.kind === 'image' || attachment.kind === 'native-image' ? (
            <MediaPreview attachment={attachment} />
          ) : (
            <span className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
              <FileText aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{attachment.name}</span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
