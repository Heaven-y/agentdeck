import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ArrowLeft, Settings2, X } from 'lucide-react';
import { buttonClass } from '../../ui/styles';

/** 页面内的原生设置详情；每个编辑视图自行处理草稿与离开保护。 */
export function SettingsDetailDialog({
  title,
  children,
  footer,
  backLabel = '返回模型设置',
  busy = false,
  embedded = false,
  showBack = true,
  onBack,
  onClose,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  backLabel?: string;
  busy?: boolean;
  embedded?: boolean;
  showBack?: boolean;
  onBack(): void;
  onClose(): void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section
      aria-labelledby={id}
      aria-busy={busy}
      className="settings-detail flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card text-foreground"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h2
          ref={heading}
          tabIndex={-1}
          id={id}
          className="flex min-w-0 items-center gap-2 text-sm font-semibold outline-none"
        >
          <Settings2 aria-hidden className="size-4 shrink-0" />
          {title}
        </h2>
        {!embedded && (
          <button
            type="button"
            className={buttonClass('ghost')}
            aria-label="关闭设置"
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden className="size-4" />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 sm:p-7">
        {showBack && (
          <button type="button" className={buttonClass('ghost')} disabled={busy} onClick={onBack}>
            <ArrowLeft aria-hidden className="size-4" />
            {backLabel}
          </button>
        )}
        {children}
      </div>
      {footer && (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
          {footer}
        </footer>
      )}
    </section>
  );
}
