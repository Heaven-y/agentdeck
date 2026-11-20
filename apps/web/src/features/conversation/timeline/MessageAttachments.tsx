import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { MessageAttachment } from '@agentdeck/shared/conversation';
import { DetailDialog } from '../../../ui/DetailDialog';
import { useConversationSurface, type ImageReader } from '../ConversationSurface';
import { unavailableImage } from '../media/native-media';

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
type Result = { attachment: MessageAttachment; reader: ImageReader; url?: string; error?: string };

function MediaPreview({ attachment }: { attachment: MessageAttachment }) {
  const { readImage } = useConversationSurface();
  const [result, setResult] = useState<Result>();
  useEffect(() => {
    if (!readImage) return;
    const abort = new AbortController();
    let created: string | undefined;
    void readImage(attachment, abort.signal).then(
      (blob) => {
        if (abort.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setResult({ attachment, reader: readImage, url: created });
      },
      (error) => {
        if (!abort.signal.aborted)
          setResult({ attachment, reader: readImage, error: error instanceof Error ? error.message : '图片不可读取' });
      },
    );
    return () => {
      abort.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [attachment, readImage]);
  if (!readImage) return <p className="text-xs text-warning">{unavailableImage}</p>;
  if (result?.attachment !== attachment || result.reader !== readImage)
    return <p className="text-xs text-muted-foreground">正在读取图片…</p>;
  if (!result.url) return <p className="text-xs text-warning">{result.error}</p>;
  return (
    <AttachmentImage
      src={result.url}
      name={attachment.name}
      onError={() => setResult({ attachment, reader: readImage, error: '图片无法显示，请重新加载或查看原文件。' })}
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
