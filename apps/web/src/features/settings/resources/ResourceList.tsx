import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, type LucideIcon } from 'lucide-react';
import { buttonClass } from '../../../ui/styles';

export const catalogListClass = 'divide-y divide-border/65';

export function ResourceRow({
  name,
  description,
  status,
  icon: Icon,
  onOpen,
  disabled,
}: {
  name: string;
  description?: string;
  status?: string;
  icon: LucideIcon;
  onOpen(trigger: HTMLButtonElement): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <li className="min-w-0 py-0.5">
      <button
        type="button"
        className="group flex min-h-14 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-control-hover focus-visible:outline-interactive disabled:cursor-default disabled:opacity-50 sm:gap-3"
        aria-labelledby={id}
        aria-describedby={
          [description && `${id}-description`, status && `${id}-status`].filter(Boolean).join(' ') || undefined
        }
        disabled={disabled}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon aria-hidden className="size-[17px]" />
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span id={id} className="block truncate text-sm font-medium text-foreground" title={name}>
            {name}
          </span>
          {description && (
            <span
              id={`${id}-description`}
              className="block truncate text-xs leading-5 text-muted-foreground"
              title={description}
            >
              {description}
            </span>
          )}
        </span>
        {status && (
          <span id={`${id}-status`} className="shrink-0 text-xs text-muted-foreground">
            {status}
          </span>
        )}
        <span
          aria-hidden
          className="hidden shrink-0 rounded-md px-1.5 text-xs text-muted-foreground group-hover:text-foreground group-focus-visible:text-foreground sm:inline"
        >
          详情
        </span>
      </button>
    </li>
  );
}

/** 切换到详情时列表保留在 DOM；返回后恢复到最初打开详情的操作。 */
export function useResourceReturnFocus(inDetail: boolean) {
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!inDetail && trigger.current) {
      if (trigger.current.isConnected) trigger.current.focus();
      trigger.current = null;
    }
  }, [inDetail]);
  return (button: HTMLButtonElement) => {
    trigger.current = button;
  };
}

export function ResourceDetails({
  title,
  backLabel = '返回列表',
  onBack,
  children,
}: {
  title: string;
  backLabel?: string;
  onBack(): void;
  children: ReactNode;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-3">
        <button type="button" className={`${buttonClass('ghost')} -ml-2 px-2`} onClick={onBack}>
          <ArrowLeft aria-hidden className="size-4" />
          {backLabel}
        </button>
        <h3
          id={id}
          ref={heading}
          tabIndex={-1}
          className="min-w-0 break-words text-[15px] font-semibold outline-none [overflow-wrap:anywhere]"
        >
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

export function ResourceFilters({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {children}
    </div>
  );
}

export function ResourceFilter({
  selected,
  children,
  onClick,
}: {
  selected: boolean;
  children: ReactNode;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-interactive aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function ResourceEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-4 py-7 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
