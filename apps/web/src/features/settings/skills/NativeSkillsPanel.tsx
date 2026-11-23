import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
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
import { inNativeScope } from '../resources/native-resource-scope';
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
    <summary className="flex cursor-pointer list-none items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.name}</p>
        {entry.description && (
          <p className="truncate text-xs text-muted-foreground" title={entry.description}>
            {entry.description}
          </p>
        )}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {entry.fileOnly ? '本地文件' : entry.state !== 'unknown' ? states[entry.state] : origins[entry.origin]}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground group-open:rotate-90" aria-hidden />
    </summary>
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
  onEdit(id: string, label: string, displayPath: string): void;
  onChanged(): void;
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
    <li>
      <details className="group">
        <SkillSummary entry={entry} />
        <div className="space-y-2 pb-3">
          <p className="break-all font-mono text-xs text-muted-foreground">{entry.source}</p>
          <p className="text-xs text-muted-foreground">
            {origins[entry.origin]} · {scopeLabel(entry.scope)}
          </p>
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
          <div className="flex flex-wrap gap-2">
            {entry.actions.edit && entry.resourceId && (
              <button
                type="button"
                className={buttonClass('outline')}
                disabled={busy}
                onClick={() => navigate(() => onEdit(entry.resourceId!, entry.name, entry.source))}
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
        </div>
      </details>
    </li>
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
  onEdit(id: string, label: string, displayPath: string): void;
  onCreate(root: NativeResourceRoot): void;
  onChanged(): void;
}) {
  const leave = useGuardedSettingsNavigation();
  const [catalog, setCatalog] = useState<NativeSkillsCatalog>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
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
  }, [agent, projectId, reload, retry]);
  return (
    <section aria-label="Skills 管理" className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}{' '}
          <button type="button" className="underline" onClick={() => setRetry((n) => n + 1)}>
            重试
          </button>
        </p>
      )}
      {!catalog && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          正在加载技能…
        </p>
      )}
      {catalog && (
        <SkillCatalogBody
          catalog={catalog}
          context={context}
          onCreate={(root) => leave(() => onCreate(root))}
          onEdit={onEdit}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

function SkillCatalogBody({
  catalog,
  context,
  onCreate,
  onEdit,
  onChanged,
}: {
  catalog: NativeSkillsCatalog;
  context: NativeManagementContext;
  onCreate(root: NativeResourceRoot): void;
  onEdit(id: string, label: string, displayPath: string): void;
  onChanged(): void;
}) {
  const roots = catalog.roots.filter((root) => root.editable && inNativeScope(context, root.scope));
  const entries = catalog.entries
    .filter((entry) => inNativeScope(context, entry.scope))
    .map((entry) => {
      const stateScopes = entry.actions.stateScopes.filter((scope) => inNativeScope(context, scope));
      return {
        ...entry,
        actions: { ...entry.actions, stateScopes, states: stateScopes.length ? entry.actions.states : [] },
      };
    });
  return (
    <>
      {catalog.warnings.map((warning) => (
        <p role="status" key={warning} className="text-sm text-muted-foreground">
          {warning}
        </p>
      ))}
      {roots.length > 0 && <AddSkill context={context} roots={roots} onCreate={onCreate} onChanged={onChanged} />}
      {entries.length ? (
        <ul className="divide-y divide-border">
          {entries.map((entry) => (
            <SkillRow key={entry.id} entry={entry} context={context} onEdit={onEdit} onChanged={onChanged} />
          ))}
        </ul>
      ) : (
        !catalog.warnings.length && <p className="text-sm text-muted-foreground">暂无技能。</p>
      )}
    </>
  );
}

function AddSkill({
  context,
  roots,
  onCreate,
  onChanged,
}: {
  context: NativeManagementContext;
  roots: NativeResourceRoot[];
  onCreate(root: NativeResourceRoot): void;
  onChanged(): void;
}) {
  const [selection, choose] = useState('');
  const root = roots.find((candidate) => candidate.id === selection) ?? roots[0];
  return (
    <details>
      <summary className="w-fit cursor-pointer text-sm font-medium">添加技能</summary>
      <div className="space-y-2 border-l border-border pl-3 pt-2">
        {roots.length > 1 && (
          <label className="block space-y-1 text-sm">
            新建位置
            <select className={inputClass} value={root?.id} onChange={(event) => choose(event.target.value)}>
              {roots.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayPath}
                </option>
              ))}
            </select>
          </label>
        )}
        {root && (
          <button type="button" className={buttonClass('outline')} onClick={() => onCreate(root)}>
            新建技能
          </button>
        )}
        <NativeSkillImport context={context} roots={roots} onChanged={onChanged} />
      </div>
    </details>
  );
}
