import { useEffect, useState } from 'react';
import { FileText, FolderInput, PackageOpen, Plus, Search } from 'lucide-react';
import type {
  NativeManagementContext,
  NativeResourceRoot,
  NativeSkillEntry,
  NativeSkillsCatalog,
} from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../../ui/styles';
import { nativeManagementApi } from './native-management-api';
import { nativeScopeNames, nativeSettingsError } from '../resources/native-resource-labels';
import { inNativeScope } from '../resources/native-resource-scope';
import {
  catalogListClass,
  ResourceDetails,
  ResourceEmpty,
  ResourceFilter,
  ResourceFilters,
  ResourceRow,
  useResourceReturnFocus,
} from '../resources/ResourceList';
import { NativeSkillDetails } from './NativeSkillDetails';
import { NativeSkillImport } from './NativeSkillImport';
import { useGuardedSettingsNavigation } from '../navigation/settings-navigation';

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

const skillSources = [
  { id: 'installed', label: '已安装' },
  { id: 'plugin', label: '插件提供' },
  { id: 'builtin', label: 'CLI 内置' },
] as const;
type SkillSource = (typeof skillSources)[number]['id'];
const sourceOf = (entry: NativeSkillEntry): SkillSource =>
  entry.origin === 'plugin' || entry.origin === 'builtin' ? entry.origin : 'installed';

function skillEntries(catalog: NativeSkillsCatalog, context: NativeManagementContext) {
  return catalog.entries
    .filter((entry) => inNativeScope(context, entry.scope))
    .map((entry) => {
      const stateScopes = entry.actions.stateScopes.filter((scope) => inNativeScope(context, scope));
      return {
        ...entry,
        actions: { ...entry.actions, stateScopes, states: stateScopes.length ? entry.actions.states : [] },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function skillFamilies(entries: NativeSkillEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map<string, NativeSkillEntry[]>();
  for (const entry of entries) {
    if (!entry.parentSkillId || !byId.has(entry.parentSkillId)) continue;
    const group = children.get(entry.parentSkillId) ?? [];
    group.push(entry);
    children.set(entry.parentSkillId, group);
  }
  const listed = (entry: NativeSkillEntry) => !entry.parentSkillId || !byId.has(entry.parentSkillId);
  return { byId, children, listed };
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
  const [selected, setSelected] = useState<{ id: string; from?: string }>();
  const [add, setAdd] = useState<'choose' | 'create' | 'import'>();
  const entries = skillEntries(catalog, context);
  const family = skillFamilies(entries);
  const roots = catalog.roots.filter((root) => root.editable && inNativeScope(context, root.scope));
  const detail = selected ? family.byId.get(selected.id) : undefined;
  const parentId = selected?.from;
  const inDetail = !!detail || !!add;
  const remember = useResourceReturnFocus(inDetail);
  return (
    <>
      {catalog.warnings.map((warning) => (
        <p role="status" key={warning} className="text-sm text-muted-foreground">
          {warning}
        </p>
      ))}
      <div hidden={inDetail}>
        <SkillList
          entries={entries}
          family={family}
          canAdd={roots.length > 0}
          incomplete={catalog.warnings.length > 0}
          onOpen={(id, button) => {
            remember(button);
            setSelected({ id });
          }}
          onAdd={(button) => {
            remember(button);
            setAdd('choose');
          }}
        />
      </div>
      {detail && (
        <NativeSkillDetails
          key={detail.id}
          context={context}
          entry={detail}
          onEdit={onEdit}
          onChanged={onChanged}
          backLabel={parentId ? '返回技能包' : undefined}
          onBack={() => setSelected(parentId ? { id: parentId } : undefined)}
        >
          {(navigate) => (
            <BundleSkills
              entries={family.children.get(detail.id)}
              onOpen={(id) => navigate(() => setSelected({ id, from: detail.id }))}
            />
          )}
        </NativeSkillDetails>
      )}
      {add && (
        <AddSkill
          mode={add}
          choose={setAdd}
          context={context}
          roots={roots}
          onCreate={onCreate}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

function BundleSkills({ entries, onOpen }: { entries?: NativeSkillEntry[]; onOpen(id: string): void }) {
  if (!entries?.length) return null;
  return (
    <section aria-label="套件内的技能" className="space-y-2">
      <h4 className="text-sm font-medium">套件内的技能</h4>
      <ul className={catalogListClass}>
        {entries.map((entry) => (
          <ResourceRow
            key={entry.id}
            name={entry.name}
            description={entry.description}
            icon={FileText}
            onOpen={() => onOpen(entry.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function deriveSkillList(
  entries: NativeSkillEntry[],
  { listed }: ReturnType<typeof skillFamilies>,
  source: SkillSource,
  query: string,
) {
  const groups = skillSources
    .map((item) => ({
      ...item,
      count: entries.filter((entry) => sourceOf(entry) === item.id && listed(entry)).length,
    }))
    .filter((item) => item.id === 'installed' || item.count > 0);
  const active = groups.some((item) => item.id === source) ? source : 'installed';
  const search = query.trim().toLocaleLowerCase();
  const matches = (entry: NativeSkillEntry) =>
    search ? `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(search) : listed(entry);
  const visible = entries.filter((entry) => sourceOf(entry) === active && matches(entry));
  return { groups, active, visible, search };
}

function SkillList({
  entries,
  family,
  canAdd,
  incomplete,
  onOpen,
  onAdd,
}: {
  entries: NativeSkillEntry[];
  family: ReturnType<typeof skillFamilies>;
  canAdd: boolean;
  incomplete: boolean;
  onOpen(id: string, trigger: HTMLButtonElement): void;
  onAdd(trigger: HTMLButtonElement): void;
}) {
  const [source, setSource] = useState<SkillSource>('installed');
  const [query, setQuery] = useState('');
  const { groups, active, visible, search } = deriveSkillList(entries, family, source, query);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {groups.length > 1 ? (
          <ResourceFilters label="技能来源">
            {groups.map((item) => (
              <ResourceFilter key={item.id} selected={item.id === active} onClick={() => setSource(item.id)}>
                {item.label} <span className="ml-0.5 tabular-nums text-muted-foreground">{item.count}</span>
              </ResourceFilter>
            ))}
          </ResourceFilters>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">{groups[0]!.count} 项技能</span>
        )}
        <SkillToolbar query={query} setQuery={setQuery} searchable={entries.length > 0} canAdd={canAdd} onAdd={onAdd} />
      </div>
      {visible.length > 0 ? (
        <ul className={catalogListClass}>
          {visible.map((entry) => (
            <SkillListRow key={entry.id} entry={entry} family={family} onOpen={(button) => onOpen(entry.id, button)} />
          ))}
        </ul>
      ) : (
        !incomplete && <ResourceEmpty>{search ? '没有匹配的技能。' : '暂无技能。'}</ResourceEmpty>
      )}
    </div>
  );
}

function SkillListRow({
  entry,
  family,
  onOpen,
}: {
  entry: NativeSkillEntry;
  family: ReturnType<typeof skillFamilies>;
  onOpen(trigger: HTMLButtonElement): void;
}) {
  const count = family.children.get(entry.id)?.length;
  const bundle = entry.parentSkillId ? family.byId.get(entry.parentSkillId)?.name : undefined;
  const disabled = entry.state === 'disabled' || entry.state === 'off';
  const status = disabled ? '已禁用' : count ? `含 ${count} 项` : undefined;
  return (
    <ResourceRow
      name={entry.name}
      description={entry.description || bundle}
      icon={count ? PackageOpen : FileText}
      status={status}
      onOpen={onOpen}
    />
  );
}

function SkillToolbar({
  query,
  setQuery,
  searchable,
  canAdd,
  onAdd,
}: {
  query: string;
  setQuery(value: string): void;
  searchable: boolean;
  canAdd: boolean;
  onAdd(trigger: HTMLButtonElement): void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {searchable && (
        <label className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            className={`${inputClass} pl-9`}
            aria-label="搜索技能"
            placeholder="搜索名称或简介"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {canAdd && (
        <button
          type="button"
          className={`${buttonClass('primary')} shrink-0 whitespace-nowrap`}
          onClick={(event) => onAdd(event.currentTarget)}
        >
          <Plus aria-hidden className="size-4" />
          添加技能
        </button>
      )}
    </div>
  );
}

function AddSkill({
  mode,
  choose,
  context,
  roots,
  onCreate,
  onChanged,
}: {
  mode: 'choose' | 'create' | 'import';
  choose(value?: 'choose' | 'create' | 'import'): void;
  context: NativeManagementContext;
  roots: NativeResourceRoot[];
  onCreate(root: NativeResourceRoot): void;
  onChanged(): void;
}) {
  const [selection, setSelection] = useState('');
  const root = roots.find((item) => item.id === selection) ?? roots[0];
  if (mode === 'import')
    return (
      <NativeSkillImport
        context={context}
        roots={roots}
        onBack={() => choose('choose')}
        onChanged={() => {
          choose();
          onChanged();
        }}
      />
    );
  return (
    <ResourceDetails
      title={mode === 'choose' ? '添加技能' : '新建技能'}
      onBack={() => choose(mode === 'choose' ? undefined : 'choose')}
    >
      {mode === 'choose' ? (
        <ul className={catalogListClass}>
          <ResourceRow
            name="新建技能"
            icon={FileText}
            onOpen={() => (roots.length === 1 && root ? onCreate(root) : choose('create'))}
          />
          <ResourceRow name="导入本地技能目录" icon={FolderInput} onOpen={() => choose('import')} />
        </ul>
      ) : (
        <div className="max-w-lg space-y-3">
          <label className="block space-y-1 text-sm">
            新建位置
            <select
              className={inputClass}
              value={root?.id ?? ''}
              onChange={(event) => setSelection(event.target.value)}
            >
              {roots.map((item) => (
                <option key={item.id} value={item.id}>
                  {nativeScopeNames[item.scope]} · {item.displayPath}
                </option>
              ))}
            </select>
          </label>
          {root && (
            <button type="button" className={buttonClass('primary')} onClick={() => onCreate(root)}>
              继续
            </button>
          )}
        </div>
      )}
    </ResourceDetails>
  );
}
