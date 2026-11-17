import type { ComponentPropsWithRef } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { inputClass } from './styles';
import { useSecretInput, type ReadSavedSecret } from './use-secret-input';

type Props = Omit<ComponentPropsWithRef<'input'>, 'type' | 'value'> & {
  label: string;
  value: string;
  readSaved?: ReadSavedSecret;
};

export function SecretInput(props: Props) {
  // 保存期间卸载临时明文和在途读取，失败后仍保留调用方的新值草稿。
  return <SecretInputControl key={String(!!props.disabled)} {...props} />;
}

function SecretFeedback({ busy, error }: { busy: boolean; error: string }) {
  return (
    <>
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          正在读取密钥…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </>
  );
}

function SecretInputControl({ label, value, className = inputClass, disabled, readSaved, onChange, ...props }: Props) {
  const { visible, saved, busy, error, clearRead, toggle } = useSecretInput(value, readSaved);
  const Icon = visible ? EyeOff : Eye;
  const action = busy ? `取消读取${label}` : `${visible ? '隐藏' : '显示'}${label}`;
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="relative">
        <input
          {...props}
          value={value || saved || ''}
          disabled={disabled}
          type={visible ? 'text' : 'password'}
          className={`${className} pr-12`}
          onChange={(event) => {
            clearRead();
            onChange?.(event);
          }}
        />
        <button
          type="button"
          aria-label={action}
          aria-pressed={visible}
          title={action}
          disabled={disabled || (!value && !readSaved)}
          className="absolute inset-y-px right-px flex w-11 items-center justify-center rounded-r-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-interactive disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => void toggle()}
        >
          <Icon aria-hidden className="size-4" />
        </button>
      </div>
      <SecretFeedback busy={busy} error={error} />
    </div>
  );
}
