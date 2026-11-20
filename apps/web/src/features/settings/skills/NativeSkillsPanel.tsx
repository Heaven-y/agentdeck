import { useEffect, useState } from 'react';
import type {
  NativeManagementContext,
  NativeResourceRoot,
  NativeResourceScope,
  NativeSkillChangeInput,
  NativeSkillEntry,
  NativeSkillsCatalog,
  NativeSkillState,
} from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../../ui/styles';
import { nativeManagementApi } from './native-management-api';
import { confirmNativeDiscard, nativeScopeNames, nativeSettingsError } from '../resources/native-resource-labels';
import { NativeSkillImport } from './NativeSkillImport';
import { useGuardedSettingsNavigation, useSettingsLeave } from '../navigation/settings-navigation';

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
function SkillSummary({ entry }: { entry: NativeSkillEntry }) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{entry.name}</h4>
        <span className="text-xs text-muted-foreground">
          {origins[entry.origin]} · {scopeLabel(entry.scope)} · {states[entry.state]}
        </span>
      </div>
      <p className="break-all font-mono text-xs text-muted-foreground">{entry.source}</p>
      {entry.description && <p className="text-sm leading-6 text-muted-foreground">{entry.description}</p>}
      {entry.unavailableReason && <p className="text-sm text-muted-foreground">{entry.unavailableReason}</p>}
    </>
  );
}
function SkillRow({
  entry,
  context,
  onEdit,
  onChanged,
}: {
  entry: NativeSkillEntry;
  context: NativeManagementContext;
  onEdit(id: string): void;
  onChanged(): void;
}) {
  const draft = useSkillDraft(entry);
  const { value, setValue, scope, setScope } = draft;
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
      if (input.action === 'state') draft.clear();
      setSaved(true);
      onChanged();
    } catch (reason) {
      setError(nativeSettingsError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="space-y-2 rounded-lg border border-border p-3">
      <SkillSummary entry={entry} />
      {entry.actions.states.length > 0 && (
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
              {entry.actions.states.map((state) => (
                <option key={state} value={state}>
                  {states[state]}
                </option>
              ))}
            </select>
          </label>
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
          <button
            className={buttonClass('outline')}
            type="button"
            disabled={busy}
            aria-label={`应用 ${entry.name} 设置`}
            onClick={() => void change({ action: 'state', value, scope })}
          >
            {busy ? '正在保存…' : '应用设置'}
          </button>
          <DraftConflict entry={entry} draft={draft} disabled={busy} />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {entry.actions.edit && entry.resourceId && (
          <button
            type="button"
            className={buttonClass('outline')}
            disabled={busy}
            onClick={() => navigate(() => onEdit(entry.resourceId!))}
          >
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
              if (window.confirm(`确定删除技能「${entry.name}」及其整个目录吗？此操作会移除脚本、参考资料和图片。`))
                void change({ action: 'delete', confirmation: entry.name });
            }}
          >
            删除技能
          </button>
        )}
      </div>
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
    </li>
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
        设置已在其他位置修改。你的草稿已保留，重新读取将放弃这些修改。
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
export default function NativeSkillsPanel({
  context,
  reload,
  onEdit,
  onCreate,
  onChanged,
}: {
  context: NativeManagementContext;
  reload: number;
  onEdit(id: string): void;
  onCreate(root: NativeResourceRoot): void;
  onChanged(): void;
}) {
  const leave = useGuardedSettingsNavigation();
  const [catalog, setCatalog] = useState<NativeSkillsCatalog>();
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const { agent, projectId } = context;
  useEffect(() => {
    const controller = new AbortController();
    void nativeManagementApi
      .skills({ agent, projectId }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setCatalog(value);
          setError('');
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(nativeSettingsError(reason));
      });
    return () => controller.abort();
  }, [agent, projectId, reload, generation]);
  const refresh = () => {
    setGeneration((value) => value + 1);
    onChanged();
  };
  return (
    <section aria-label="Skills 管理" className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      {!catalog && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          正在加载技能…
        </p>
      )}
      {catalog && (
        <>
          {catalog.warnings.map((warning) => (
            <p role="status" key={warning} className="text-sm text-muted-foreground">
              {warning}
            </p>
          ))}
          {agent === 'claude' && catalog.entries.some((entry) => entry.actions.states.length > 0) && (
            <p className="text-xs text-muted-foreground">同名技能共用可见性设置。</p>
          )}
          <div className="flex flex-wrap gap-2">
            {catalog.roots
              .filter((root) => root.editable)
              .map((root) => (
                <button
                  key={root.id}
                  className={buttonClass('outline')}
                  type="button"
                  onClick={() => leave(() => onCreate(root))}
                >
                  新建 Skill · {nativeScopeNames[root.scope]}
                </button>
              ))}
          </div>
          {catalog.roots.some((root) => root.editable) && (
            <NativeSkillImport context={context} roots={catalog.roots} onChanged={refresh} />
          )}
          {catalog.entries.length ? (
            <ul className="space-y-3">
              {catalog.entries.map((entry) => (
                <SkillRow key={entry.id} entry={entry} context={context} onEdit={onEdit} onChanged={refresh} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">当前未发现技能，可新建或导入本地目录。</p>
          )}
        </>
      )}
    </section>
  );
}
