import { AGENT_KINDS } from '@agentdeck/shared/conversation';
import { AGENT_FULL_NAMES } from '../../../cli/shared/labels';
import { useId } from 'react';
import { buttonClass, inputClass } from '../../../ui/styles';
import { type ProductSettingsDraft } from './product-settings-draft';

const widthOptions = [
  ['small', '小'],
  ['medium', '中'],
  ['large', '大'],
  ['custom', '自定义'],
] as const;

type Props = {
  draft: ProductSettingsDraft;
  disabled: boolean;
  change(patch: Partial<ProductSettingsDraft>): void;
};
export function ProductSettingsForm(props: Props) {
  const id = useId();
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-medium">新会话默认值</h3>
        <p className="text-sm leading-6 text-muted-foreground">用于新会话，已有会话和当前轮次保持原设置。</p>
      </div>
      <label htmlFor={`${id}-agent`} className="flex max-w-xs flex-col gap-1.5 text-sm">
        默认 Agent
        <select
          id={`${id}-agent`}
          className={inputClass}
          disabled={props.disabled}
          value={props.draft.defaultAgent}
          onChange={(event) =>
            props.change({ defaultAgent: event.target.value as ProductSettingsDraft['defaultAgent'] })
          }
        >
          {AGENT_KINDS.map((agent) => (
            <option key={agent} value={agent}>
              {AGENT_FULL_NAMES[agent]}
            </option>
          ))}
        </select>
      </label>
      <section className="space-y-3 border-t border-border pt-4">
        <div className="space-y-1">
          <h3 className="font-medium">对话与侧栏</h3>
          <p className="text-sm leading-6 text-muted-foreground">影响界面的显示密度；侧栏拖拽宽度仍由本机记住。</p>
        </div>
        <label htmlFor={`${id}-limit`} className="flex max-w-xs flex-col gap-1.5 text-sm">
          每个项目显示的会话条数
          <input
            id={`${id}-limit`}
            type="number"
            min={1}
            max={20}
            className={inputClass}
            disabled={props.disabled}
            value={props.draft.sessionLimit}
            onChange={(event) => props.change({ sessionLimit: event.target.value })}
          />
        </label>
        <fieldset className="space-y-1.5 text-sm" disabled={props.disabled}>
          <legend className="mb-1.5">对话区宽度</legend>
          <div className="flex flex-wrap gap-1.5">
            {widthOptions.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={props.draft.widthPreset === value}
                onClick={() => props.change({ widthPreset: value })}
                className={`${buttonClass(props.draft.widthPreset === value ? 'outline' : 'ghost')} ${props.draft.widthPreset === value ? 'bg-muted' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
          {props.draft.widthPreset === 'custom' && (
            <label className="flex max-w-xs flex-col gap-1.5">
              自定义宽度（480–1400 像素）
              <input
                type="number"
                min={480}
                max={1400}
                className={inputClass}
                value={props.draft.customWidth}
                onChange={(event) => props.change({ customWidth: event.target.value })}
              />
            </label>
          )}
        </fieldset>
      </section>
    </section>
  );
}
