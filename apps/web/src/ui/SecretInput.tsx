import { useState, type ComponentPropsWithRef } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { inputClass } from './styles';

type Props = Omit<ComponentPropsWithRef<'input'>, 'type' | 'value'> & { label: string; value: string };

export function SecretInput({ label, value, className = inputClass, disabled, ...props }: Props) {
  const [visible, setVisible] = useState(false);
  // 保存、切换配置或手动清空草稿后，下一次输入恢复隐藏。
  if (!value && visible) setVisible(false);
  const Icon = visible ? EyeOff : Eye;
  const action = `${visible ? '隐藏' : '显示'}${label}`;
  return (
    <div className="relative min-w-0 flex-1">
      <input
        {...props}
        value={value}
        disabled={disabled}
        type={visible ? 'text' : 'password'}
        className={`${className} pr-12`}
      />
      <button
        type="button"
        aria-label={action}
        aria-pressed={visible}
        title={action}
        disabled={disabled || !value}
        className="absolute inset-y-px right-px flex w-11 items-center justify-center rounded-r-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-interactive disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => setVisible(!visible)}
      >
        <Icon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
