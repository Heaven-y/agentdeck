import type { InteractionField } from '@agentdeck/shared/conversation';
import { inputClass } from '../../../ui/styles';
export type FormValue = string | number | boolean | string[];
type Props = {
  field: InteractionField;
  value?: FormValue;
  change(value?: FormValue): void;
  error?: string;
  disabled: boolean;
  prefix: string;
};
function Choices({
  field,
  value,
  change,
  disabled,
  prefix,
}: Props & { field: Extract<InteractionField, { type: 'choice' }> }) {
  const values = Array.isArray(value) ? value : [typeof value === 'string' ? value : ''];
  const known = new Set(field.options.map((option) => option.value));
  const others = values.filter((value) => value && !known.has(value));
  return (
    <div className="space-y-2">
      {field.options.map((option, index) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-2 text-sm"
        >
          <input
            className="mt-1"
            type={field.multiple ? 'checkbox' : 'radio'}
            name={`${prefix}-${field.id}`}
            value={option.value}
            checked={values.includes(option.value)}
            disabled={disabled}
            onChange={(event) =>
              change(
                field.multiple
                  ? event.target.checked
                    ? [...values.filter(Boolean), option.value]
                    : values.filter((value) => value !== option.value)
                  : option.value,
              )
            }
            aria-describedby={option.description ? `${prefix}-${field.id}-${index}-description` : undefined}
          />
          <span className="min-w-0 break-words">
            {option.label}
            {option.description && (
              <span
                id={`${prefix}-${field.id}-${index}-description`}
                className="mt-1 block text-xs text-muted-foreground"
              >
                {option.description}
              </span>
            )}
          </span>
        </label>
      ))}
      {field.allowOther && (
        <label className="block text-xs">
          其他回答
          <input
            className={`${inputClass} mt-1`}
            type={field.secret ? 'password' : 'text'}
            value={others.join(', ')}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) =>
              change(
                field.multiple
                  ? [...values.filter((value) => known.has(value)), ...(event.target.value ? [event.target.value] : [])]
                  : event.target.value,
              )
            }
          />
        </label>
      )}
    </div>
  );
}
function Control(props: Props) {
  const { field, value, change, disabled, prefix } = props;
  const id = `${prefix}-${field.id}`;
  if (field.type === 'choice') return <Choices {...props} field={field} />;
  if (field.type === 'boolean')
    return (
      <select
        id={id}
        className={inputClass}
        value={typeof value === 'boolean' ? String(value) : ''}
        disabled={disabled}
        onChange={(event) => change(event.target.value === '' ? undefined : event.target.value === 'true')}
      >
        <option value="">请选择</option>
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  const type = field.type === 'number' ? 'number' : field.secret ? 'password' : 'text';
  return (
    <input
      id={id}
      className={inputClass}
      type={type}
      step={numberStep(field)}
      autoComplete="off"
      value={typeof value === 'string' || typeof value === 'number' ? value : ''}
      disabled={disabled}
      aria-invalid={!!props.error}
      aria-describedby={props.error ? `${id}-error` : undefined}
      onChange={(event) =>
        change(
          event.target.value === ''
            ? undefined
            : field.type === 'number'
              ? Number(event.target.value)
              : event.target.value,
        )
      }
    />
  );
}
function numberStep(field: InteractionField): number | 'any' | undefined {
  return field.type === 'number' ? (field.integer ? 1 : 'any') : undefined;
}
export function InteractionFieldInput(props: Props) {
  const id = `${props.prefix}-${props.field.id}`;
  return (
    <fieldset className="min-w-0 space-y-2" disabled={props.disabled}>
      <legend className="mb-2 text-sm font-medium break-words">
        {props.field.label}
        {props.field.required && <span className="ml-1 text-muted-foreground">*</span>}
      </legend>
      {props.field.description && (
        <p className="text-xs text-muted-foreground break-words">{props.field.description}</p>
      )}
      <label className="sr-only" htmlFor={id}>
        {props.field.label}
      </label>
      <Control {...props} />
      {props.error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive-foreground">
          {props.error}
        </p>
      )}
    </fieldset>
  );
}
