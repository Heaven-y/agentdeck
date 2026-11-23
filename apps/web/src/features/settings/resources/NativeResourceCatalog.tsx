import type { NativeResource, NativeResourceCatalog as Catalog, NativeResourceRoot } from '@agentdeck/shared/settings';
import { ChevronRight, FilePlus2 } from 'lucide-react';
import { buttonClass } from '../../../ui/styles';
import { nativeKindNames, nativeScopeNames } from './native-resource-labels';

export type NativeResourceTarget = Pick<NativeResource, 'id' | 'label' | 'displayPath'> & { description?: string };
export type NativeResourceSelection = { resource: NativeResourceTarget } | { root: NativeResourceRoot };

function ResourceRow({ resource, open }: { resource: NativeResource; open(): void }) {
  const state = resource.unavailableReason ?? (resource.exists ? '文件已存在' : '文件尚未创建');
  return (
    <li className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{resource.label}</h4>
        <span className="text-xs text-muted-foreground">
          {nativeKindNames[resource.kind]} · {state}
        </span>
      </div>
      <p className="break-all font-mono text-xs text-muted-foreground">{resource.displayPath}</p>
      {resource.description && <p className="text-sm leading-6 text-muted-foreground">{resource.description}</p>}
      <button
        type="button"
        className={buttonClass('outline')}
        disabled={!!resource.unavailableReason}
        onClick={open}
        aria-label={`${resource.editable ? '显示并编辑' : '显示'} ${resource.label}`}
      >
        {resource.editable ? '显示并编辑文件' : '显示文件（只读）'}
      </button>
    </li>
  );
}

function ResourceRoot({ root, create }: { root: NativeResourceRoot; create(): void }) {
  return (
    <li className="space-y-2 rounded-lg border border-dashed border-border-strong p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{root.label}</h4>
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={!root.editable}
          onClick={create}
          aria-label={`在${root.label}中新建${rootKindLabel(root)}`}
        >
          <FilePlus2 aria-hidden className="size-4" />
          新建{rootKindLabel(root)}
        </button>
      </div>
      <p className="break-all font-mono text-xs text-muted-foreground">{root.displayPath}</p>
      {root.unavailableReason && <p className="text-sm text-muted-foreground">{root.unavailableReason}</p>}
    </li>
  );
}
const rootKindLabel = (root: NativeResourceRoot) =>
  root.kind === 'skills' ? ' Skill' : root.kind === 'agents' ? '代理定义' : '规则';

export function NativeResourceCatalog({
  catalog,
  select,
}: {
  catalog: Catalog;
  select(target: NativeResourceSelection): void;
}) {
  const scopes = [
    ...new Set([...catalog.entries.map((item) => item.scope), ...catalog.roots.map((item) => item.scope)]),
  ];
  return (
    <div className="space-y-5">
      {catalog.warnings.map((warning) => (
        <p key={warning} role="status" className="text-sm text-muted-foreground">
          {warning}
        </p>
      ))}
      {scopes.map((scope) => (
        <section key={scope} aria-label={`${nativeScopeNames[scope]}原生资源`} className="space-y-3">
          <h3 className="text-sm font-semibold">{nativeScopeNames[scope]}</h3>
          <ul className="space-y-3">
            {catalog.entries
              .filter((entry) => entry.scope === scope)
              .map((resource) => (
                <ResourceRow key={resource.id} resource={resource} open={() => select({ resource })} />
              ))}
            {catalog.roots
              .filter((root) => root.scope === scope)
              .map((root) => (
                <ResourceRoot key={root.id} root={root} create={() => select({ root })} />
              ))}
          </ul>
        </section>
      ))}
      {scopes.length === 0 && <p className="text-sm text-muted-foreground">当前没有可浏览的原生文件。</p>}
      {catalog.guidance.length > 0 && (
        <details aria-label="CLI 原生能力说明" className="group/guide space-y-3 border-t border-border pt-4">
          <summary className="inline-flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 text-sm font-medium marker:hidden transition-colors select-none hover:text-foreground">
            <ChevronRight
              aria-hidden
              className="size-3.5 text-muted-foreground transition-transform group-open/guide:rotate-90"
            />
            文件与能力说明
          </summary>
          {catalog.guidance.map((item) => (
            <div key={item.label} className="space-y-1">
              <h4 className="text-sm font-medium">{item.label}</h4>
              <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
              {item.command && <code className="block break-all rounded bg-muted p-2 text-xs">{item.command}</code>}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
