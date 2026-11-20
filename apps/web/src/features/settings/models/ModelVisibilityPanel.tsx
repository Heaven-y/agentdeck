import { useState } from 'react';
import type { AgentKind, AgentModel } from '@agentdeck/shared/conversation';
import { buttonClass, inputClass } from '../../../ui/styles';
import { matchingModels, visibilityCandidates, type ModelCandidate } from '../../../cli/shared/model-candidates';
import { modelDisplay } from '../../../cli/shared/model-identity';
import type { VisibilitySelection, VisibilityDraftView } from './use-visibility-draft';

/**
 * 只改本机产品偏好草稿；范围与模型表单一起由设置页底部“保存配置”提交。
 * 清单与对话菜单共用同一身份合并，原生别名不重复占行。
 */
export function ModelVisibilityPanel({
  agent,
  models,
  connectionLabel,
  draft,
}: {
  agent: AgentKind;
  models: AgentModel[];
  connectionLabel?: string;
  draft: VisibilityDraftView;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(50);
  const choices = visibilityCandidates(agent, models);
  const checked = (model: ModelCandidate) => {
    const selected = draft.selected;
    return selected === 'all' || (model.equivalentIds ?? [model.id]).some((id) => selected.includes(id));
  };
  const matches = matchingModels(choices, query);
  const disabled = !draft.ready;
  const update = (selection: VisibilitySelection) => draft.change(selection);
  const toggle = (model: ModelCandidate, enabled: boolean) => {
    const base = draft.selected === 'all' ? choices.map((entry) => entry.id) : draft.selected;
    const equivalentIds = new Set(model.equivalentIds ?? [model.id]);
    const retained = base.filter((id) => !equivalentIds.has(id));
    update([...new Set(enabled ? [...retained, model.id] : retained)]);
  };
  return (
    <section aria-label="对话菜单中的模型" className="space-y-3 border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[13px] font-medium">对话菜单中的模型</h4>
        <span role="status" className="text-xs text-muted-foreground">
          {draft.dirty ? '保存设置后生效' : ''}
        </span>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {connectionLabel && `仅应用于${connectionLabel}。`}
        选择日常使用的型号；当前会话使用的模型始终保留。
      </p>
      {choices.length > 0 ? (
        <>
          <input
            aria-label="筛选模型显示列表"
            value={query}
            placeholder="搜索型号"
            className={inputClass}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(50);
            }}
          />
          <div className="rounded-lg border border-border p-1">
            {matches.slice(0, limit).map((model) => (
              <label
                key={model.id}
                className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-muted/60"
              >
                <input
                  type="checkbox"
                  aria-label={`显示 ${modelDisplay(model.id, model)}`}
                  checked={checked(model)}
                  disabled={disabled}
                  onChange={(event) => toggle(model, event.target.checked)}
                />
                <span className="min-w-0 truncate" title={model.id}>
                  {modelDisplay(model.id, model)}
                </span>
              </label>
            ))}
            {!matches.length && <p className="p-2 text-xs text-muted-foreground">没有匹配的模型</p>}
          </div>
          {matches.length > limit && (
            <button type="button" className={`${buttonClass('ghost')} self-start`} onClick={() => setLimit(limit + 50)}>
              显示更多（还有 {matches.length - limit} 个）
            </button>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass('ghost')} disabled={disabled} onClick={() => update([])}>
              全部隐藏
            </button>
            <button type="button" className={buttonClass('ghost')} disabled={disabled} onClick={() => update('all')}>
              恢复全部模型
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">获取模型后可选择显示范围。</p>
      )}
      {draft.error && (
        <div className="text-xs text-destructive-foreground">
          <p role="alert">{draft.error}</p>
          <button type="button" className={buttonClass('ghost')} onClick={draft.reload}>
            重新读取显示设置
          </button>
        </div>
      )}
    </section>
  );
}
