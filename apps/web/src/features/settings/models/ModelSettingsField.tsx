import { useId, useRef, type ChangeEvent, type ReactNode, type RefObject } from 'react';
import { CircleHelp } from 'lucide-react';
import type { ModelSettingField, SecretValue } from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../../ui/styles';
import { FieldSelect, FieldSuggestions } from '../../../ui/fields/FieldSelect';
import { SecretInput } from '../../../ui/fields/SecretInput';
type Props = {
  field: ModelSettingField;
  value: string;
  cleared: boolean;
  disabled: boolean;
  change(value: string | null): void;
  suggestions?: Array<{ value: string; label: string }>;
  action?: ReactNode;
  secretIdentity?: string;
  readSecret?(signal: AbortSignal): Promise<SecretValue>;
};

function SecretActions({
  field,
  cleared,
  disabled,
  change,
  inputRef,
}: {
  field: ModelSettingField;
  cleared: boolean;
  disabled: boolean;
  change(value: string | null): void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  if (!field.secret || !field.hasValue || field.readOnly) return null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {!cleared && (
        <button
          type="button"
          className={`${buttonClass('ghost')} px-2`}
          disabled={disabled}
          aria-label={`更换${field.label}`}
          onClick={() => inputRef.current?.focus()}
        >
          更换
        </button>
      )}
      <button
        type="button"
        className={`${buttonClass('ghost')} px-2`}
        disabled={disabled}
        aria-label={`${cleared ? '保留' : '清除'}${field.label}`}
        onClick={() => change(cleared ? '' : null)}
      >
        {cleared ? '撤销' : '清除'}
      </button>
    </div>
  );
}

function placeholderFor(field: ModelSettingField, cleared: boolean) {
  if (cleared) return '未填写';
  if (field.secret && field.hasValue) return '••••••••';
  return field.placeholder ?? '自动';
}
function FieldControl({
  id,
  inputRef,
  field,
  value,
  cleared,
  disabled,
  change,
  suggestions,
  secretIdentity,
  readSecret,
}: Props & { id: string; inputRef: RefObject<HTMLInputElement | null> }) {
  if (field.options)
    return (
      <FieldSelect
        id={id}
        label={field.label}
        disabled={disabled || field.readOnly}
        value={value}
        options={field.options}
        onChange={change}
      />
    );
  if (suggestions && !field.secret)
    return (
      <FieldSuggestions
        id={id}
        label={field.label}
        inputRef={inputRef}
        value={value}
        options={suggestions}
        disabled={disabled}
        readOnly={field.readOnly}
        onChange={change}
        placeholder={placeholderFor(field, cleared)}
      />
    );
  const inputProps = {
    id,
    ref: inputRef,
    className: `${inputClass} min-h-10 read-only:bg-muted/40 read-only:text-muted-foreground`,
    value,
    disabled,
    readOnly: field.readOnly,
    autoComplete: 'off',
    spellCheck: false,
    maxLength: 4096,
    placeholder: placeholderFor(field, cleared),
    onChange: (event: ChangeEvent<HTMLInputElement>) => change(event.target.value),
  };
  return field.secret ? (
    <SecretInput
      key={`${secretIdentity}:${cleared}`}
      {...inputProps}
      label={field.label}
      readSaved={field.hasValue && !cleared ? readSecret : undefined}
    />
  ) : (
    <input
      {...inputProps}
      type={field.inputType ?? 'text'}
      {...(field.inputType === 'number' ? { min: 1, step: 1 } : {})}
    />
  );
}

export function ModelSettingsField({
  field,
  value,
  cleared,
  disabled,
  change,
  suggestions,
  action,
  secretIdentity,
  readSecret,
}: Props) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const inlineHint = ['authMode', 'envKey'].includes(field.key);
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="flex items-center gap-1.5 text-[13px] font-medium">
        {field.label}
        {field.hint && !inlineHint && (
          <span title={field.hint} aria-hidden className="text-muted-foreground">
            <CircleHelp className="size-3.5" />
          </span>
        )}
      </label>
      <div className="model-field-row flex min-w-0 items-center gap-2">
        <FieldControl
          {...{ id, inputRef, field, value, cleared, disabled, change, suggestions, secretIdentity, readSecret }}
        />
        {action}
        <SecretActions field={field} cleared={cleared} disabled={disabled} change={change} inputRef={inputRef} />
      </div>
      {field.hint && inlineHint && <p className="text-xs leading-5 text-muted-foreground">{field.hint}</p>}
    </div>
  );
}
