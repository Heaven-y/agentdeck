import { useState } from 'react';
import type { NativeResource, NativeResourceCatalog as Catalog, NativeResourceRoot } from '@agentdeck/shared/settings';
import { FileText, FolderPlus, Plus } from 'lucide-react';
import { buttonClass } from '../../../ui/styles';
import { nativeScopeNames } from './native-resource-labels';
import { catalogListClass, ResourceDetails, ResourceEmpty, ResourceRow, useResourceReturnFocus } from './ResourceList';

export type NativeResourceTarget = Pick<NativeResource, 'id' | 'label' | 'displayPath'> & { description?: string };
export type NativeResourceSelection = { resource: NativeResourceTarget } | { root: NativeResourceRoot };
type SelectResource = (target: NativeResourceSelection) => void;

function Files({ entries, select }: { entries: NativeResource[]; select: SelectResource }) {
  const scopes = [...new Set(entries.map((entry) => entry.scope))];
  return scopes.map((scope) => (
    <section key={scope} aria-label={`${nativeScopeNames[scope]}文件`} className="space-y-1">
      {(scopes.length > 1 || scope !== 'user') && (
        <h3 className="text-xs font-medium text-muted-foreground">{nativeScopeNames[scope]}</h3>
      )}
      <ul className={catalogListClass}>
        {entries
          .filter((entry) => entry.scope === scope)
          .map((resource) => (
            <ResourceRow
              key={resource.id}
              name={resource.label}
              icon={FileText}
              description={
                resource.unavailableReason
                  ? `${resource.displayPath} · ${resource.unavailableReason}`
                  : resource.displayPath
              }
              status={!resource.editable && !resource.unavailableReason ? '只读' : undefined}
              disabled={!!resource.unavailableReason}
              onOpen={() => select({ resource })}
            />
          ))}
      </ul>
    </section>
  ));
}

const createLabels: Record<NativeResourceRoot['kind'], string> = {
  rules: '新建规则',
  skills: '新建 Skill',
  agents: '新建代理定义',
};

function CreateChoices({
  pending,
  roots,
  select,
}: {
  pending: NativeResource[];
  roots: NativeResourceRoot[];
  select: SelectResource;
}) {
  return (
    <>
      {pending.length > 0 && (
        <section aria-label="预设文件" className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">预设文件</h4>
          <Files entries={pending} select={select} />
        </section>
      )}
      {roots.length > 0 && (
        <section aria-label="在目录中创建" className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">在目录中创建</h4>
          <ul className={catalogListClass}>
            {roots.map((root) => (
              <ResourceRow
                key={root.id}
                name={createLabels[root.kind]}
                icon={FolderPlus}
                description={
                  root.unavailableReason ? `${root.displayPath} · ${root.unavailableReason}` : root.displayPath
                }
                disabled={!root.editable}
                onOpen={() => select({ root })}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function NativeResourceCatalog({ catalog, select }: { catalog: Catalog; select: SelectResource }) {
  const [view, setView] = useState<'create' | 'help'>();
  const remember = useResourceReturnFocus(!!view);
  const files = catalog.entries.filter((entry) => entry.exists || entry.unavailableReason);
  const pending = catalog.entries.filter((entry) => !entry.exists && entry.editable && !entry.unavailableReason);
  const canCreate = pending.length > 0 || catalog.roots.some((root) => root.editable);
  return (
    <div className="space-y-4">
      {catalog.warnings.map((warning) => (
        <p key={warning} role="status" className="text-sm text-muted-foreground">
          {warning}
        </p>
      ))}
      <div hidden={!!view} className="space-y-3">
        <div className="flex flex-wrap justify-end gap-2 empty:hidden">
          {catalog.guidance.length > 0 && (
            <button
              type="button"
              className={buttonClass('ghost')}
              onClick={(event) => {
                remember(event.currentTarget);
                setView('help');
              }}
            >
              文件说明
            </button>
          )}
          {canCreate && (
            <button
              type="button"
              className={buttonClass('primary')}
              onClick={(event) => {
                remember(event.currentTarget);
                setView('create');
              }}
            >
              <Plus aria-hidden className="size-4" />
              新建文件
            </button>
          )}
        </div>
        {files.length > 0 ? <Files entries={files} select={select} /> : <ResourceEmpty>暂无原生文件。</ResourceEmpty>}
      </div>
      {view === 'create' && (
        <ResourceDetails title="新建文件" onBack={() => setView(undefined)}>
          <CreateChoices pending={pending} roots={catalog.roots} select={select} />
        </ResourceDetails>
      )}
      {view === 'help' && (
        <ResourceDetails title="文件说明" onBack={() => setView(undefined)}>
          {catalog.guidance.map((item) => (
            <div key={item.label} className="space-y-1">
              <h4 className="text-sm font-medium">{item.label}</h4>
              <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
              {item.command && <code className="block break-all rounded bg-muted p-2 text-xs">{item.command}</code>}
            </div>
          ))}
        </ResourceDetails>
      )}
    </div>
  );
}
