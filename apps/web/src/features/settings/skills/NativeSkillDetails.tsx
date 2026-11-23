import { useState, type ReactNode } from 'react';
import type {
  NativeManagementContext,
  NativeResourceScope,
  NativeSkillChangeInput,
  NativeSkillEntry,
  NativeSkillState,
} from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../../ui/styles';
import { nativeManagementApi } from './native-management-api';
import { confirmNativeDiscard, nativeScopeNames, nativeSettingsError } from '../resources/native-resource-labels';
import { useGuardedSettingsNavigation, useSettingsLeave, type SettingsLeave } from '../navigation/settings-navigation';
import { ResourceDetails } from '../resources/ResourceList';

const states: Record<NativeSkillState, string> = {
  inherit: '默认继承',
  on: '完整显示',
  'name-only': '仅显示名称',
  'user-invocable-only': '仅手动调用',
  off: '隐藏并停用',
  enabled: '已启用',
  disabled: '已禁用',
  unknown: '—',
};
const origins = {
  owned: '自有目录',
  plugin: '来自插件',
  managed: '管理员',
  builtin: '内置',
  external: '外部来源',
  synced: '账号同步',
};
const scopeLabel = (scope: NativeSkillEntry['scope']) =>
  nativeScopeNames[scope as NativeResourceScope] ??
  ({ admin: '管理员', system: '系统', unknown: '原生来源' } as Record<string, string>)[scope];
function defaultScope(entry: NativeSkillEntry): NativeResourceScope {
  return entry.actions.stateScopes.find((scope) => scope === entry.scope) ?? entry.actions.stateScopes.at(-1) ?? 'user';
}
const stateAt = (entry: NativeSkillEntry, scope: NativeResourceScope) => entry.stateByScope?.[scope] ?? entry.state;
type StateDraft = { value: NativeSkillState; revision: string };
function useSkillDraft(entry: NativeSkillEntry) {
  const [selectedScope, setScope] = useState<NativeResourceScope>(() => defaultScope(entry));
  const [drafts, setDrafts] = useState<Partial<Record<NativeResourceScope, StateDraft>>>({});
  const scope = entry.actions.stateScopes.includes(selectedScope) ? selectedScope : defaultScope(entry);
  const draft = drafts[scope];
  const setValue = (value: NativeSkillState) =>
    setDrafts((previous) => ({
      ...previous,
      [scope]: { value, revision: previous[scope]?.revision ?? entry.revision },
    }));
  const clear = () =>
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[scope];
      return next;
    });
  return {
    scope,
    setScope,
    value: draft?.value ?? stateAt(entry, scope),
    revision: draft?.revision ?? entry.revision,
    setValue,
    clear,
    dirty: Object.keys(drafts).length > 0,
    outdated: !!draft && draft.revision !== entry.revision,
  };
}
export function NativeSkillDetails({
  entry,
  context,
  onEdit,
  onChanged,
  onBack,
  backLabel,
  children,
}: {
  entry: NativeSkillEntry;
  context: NativeManagementContext;
  onEdit(id: string, label: string, displayPath: string): void;
  onChanged(): void;
  onBack(): void;
  backLabel?: string;
  children?(navigate: SettingsLeave): ReactNode;
}) {
  const draft = useSkillDraft(entry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const leave = (action: () => void) => {
    if (!busy && confirmNativeDiscard(draft.dirty)) action();
  };
  useSettingsLeave(leave, draft.dirty || busy);
  const navigate = useGuardedSettingsNavigation(leave);
  async function change(input: Omit<NativeSkillChangeInput, 'id' | 'revision'>) {
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      await nativeManagementApi.changeSkill(context, {
        ...input,
        id: entry.id,
        revision: input.action === 'state' ? draft.revision : entry.revision,
      });
      if (input.action === 'state') {
        draft.clear();
        setSaved(true);
      } else onBack();
      onChanged();
    } catch (reason) {
      setError(nativeSettingsError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResourceDetails title={entry.name} backLabel={backLabel} onBack={() => navigate(onBack)}>
      {entry.description && <p className="whitespace-pre-line break-words text-sm leading-6">{entry.description}</p>}
      <dl className="space-y-2 rounded-lg bg-muted/55 p-3 text-xs">
        <div className="grid grid-cols-[4em_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">来源</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{entry.source}</dd>
        </div>
        <div className="grid grid-cols-[4em_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">类型</dt>
          <dd>
            {origins[entry.origin]} · {scopeLabel(entry.scope)}
          </dd>
        </div>
      </dl>
      {entry.unavailableReason && <p className="text-sm text-muted-foreground">{entry.unavailableReason}</p>}
      {context.agent === 'claude' && entry.actions.states.length > 0 && (
        <p className="text-xs text-muted-foreground">同名技能共用可见性设置。</p>
      )}
      <SkillVisibilityForm
        entry={entry}
        draft={draft}
        busy={busy}
        apply={(value, scope) => void change({ action: 'state', value, scope })}
      />
      <SkillDetailActions
        entry={entry}
        busy={busy}
        onEdit={(id) => navigate(() => onEdit(id, entry.name, entry.source))}
        onDelete={() => void change({ action: 'delete', confirmation: entry.name })}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-muted-foreground">
          已保存，下次对话生效。
        </p>
      )}
      {children?.(navigate)}
    </ResourceDetails>
  );
}
function SkillDetailActions({
  entry,
  busy,
  onEdit,
  onDelete,
}: {
  entry: NativeSkillEntry;
  busy: boolean;
  onEdit(id: string): void;
  onDelete(): void;
}) {
  const editId = entry.actions.edit ? entry.resourceId : undefined;
  if (!editId && !entry.actions.delete) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {editId && (
        <button type="button" className={buttonClass('outline')} disabled={busy} onClick={() => onEdit(editId)}>
          编辑 SKILL.md
        </button>
      )}
      {entry.actions.delete && (
        <button
          type="button"
          className={buttonClass('danger')}
          disabled={busy}
          aria-label={`删除 ${entry.name}`}
          onClick={() => {
            if (window.confirm(`删除技能「${entry.name}」及其整个目录？脚本、参考资料和图片也将删除。`)) onDelete();
          }}
        >
          删除技能
        </button>
      )}
    </div>
  );
}

function SkillVisibilityForm({
  entry,
  draft,
  busy,
  apply,
}: {
  entry: NativeSkillEntry;
  draft: ReturnType<typeof useSkillDraft>;
  busy: boolean;
  apply(value: NativeSkillState, scope: NativeResourceScope): void;
}) {
  if (!entry.actions.states.length) return null;
  const { value, setValue, scope, setScope } = draft;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-40 flex-1 space-y-1 text-sm">
        可见性
        <select
          className={inputClass}
          aria-label={`${entry.name} 可见性`}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value as NativeSkillState)}
        >
          {!entry.actions.states.includes(value) && (
            <option value={value} disabled>
              请选择
            </option>
          )}
          {entry.actions.states.map((state) => (
            <option key={state} value={state}>
              {states[state]}
            </option>
          ))}
        </select>
      </label>
      {entry.actions.stateScopes.length > 1 && (
        <label className="min-w-32 space-y-1 text-sm">
          写入范围
          <select
            className={inputClass}
            aria-label={`${entry.name} 写入范围`}
            value={scope}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as NativeResourceScope;
              setScope(next);
            }}
          >
            {entry.actions.stateScopes.map((scope) => (
              <option key={scope} value={scope}>
                {nativeScopeNames[scope]}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        className={buttonClass('outline')}
        type="button"
        disabled={busy || !entry.actions.states.includes(value)}
        aria-label={`应用 ${entry.name} 设置`}
        onClick={() => apply(value, scope)}
      >
        {busy ? '正在保存…' : '应用设置'}
      </button>
      <DraftConflict entry={entry} draft={draft} disabled={busy} />
    </div>
  );
}

function DraftConflict({
  entry,
  draft,
  disabled,
}: {
  entry: NativeSkillEntry;
  draft: ReturnType<typeof useSkillDraft>;
  disabled: boolean;
}) {
  if (!draft.outdated) return null;
  return (
    <div className="w-full space-y-2">
      <p role="status" className="text-sm text-muted-foreground">
        设置已在其他位置修改。可保留草稿，或放弃草稿并使用最新设置。
      </p>
      <button
        type="button"
        className={buttonClass('outline')}
        disabled={disabled}
        aria-label={`放弃 ${entry.name} 草稿并采用最新设置`}
        onClick={draft.clear}
      >
        放弃草稿并采用最新设置
      </button>
    </div>
  );
}
