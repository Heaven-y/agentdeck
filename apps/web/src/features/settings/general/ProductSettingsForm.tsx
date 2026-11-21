import { AGENT_KINDS } from '@agentdeck/shared/conversation';
import { AGENT_FULL_NAMES } from '../../../cli/shared/labels';
import { useId } from 'react';
import { SegmentedControl } from '../../../ui/fields/SegmentedControl';
import { inputClass } from '../../../ui/styles';
import { type ProductSettingsDraft } from './product-settings-draft';

const widthOptions = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
  { value: 'custom', label: '自定义' },
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
        <h3 className="text-sm font-semibold">新会话默认值</h3>
      </div>
      <label htmlFor={`${id}-agent`} className="flex max-w-xs flex-col gap-1.5 text-[13px] font-medium">
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
      <section className="space-y-3.5 border-t border-border pt-5">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">对话与侧栏</h3>
        </div>
        <label htmlFor={`${id}-limit`} className="flex max-w-xs flex-col gap-1.5 text-[13px] font-medium">
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
        <fieldset className="space-y-2 text-sm" disabled={props.disabled}>
          <legend className="mb-1.5 text-[13px] font-medium">对话区宽度</legend>
          <SegmentedControl
            label="对话区宽度"
            value={props.draft.widthPreset}
            disabled={props.disabled}
            options={widthOptions}
            onChange={(widthPreset) => props.change({ widthPreset })}
          />
          {props.draft.widthPreset === 'custom' && (
            <label className="mt-2 flex max-w-xs flex-col gap-1.5 text-[13px]">
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
