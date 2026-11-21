import { Tab, TabList, TabProvider } from '@ariakit/react';
import { Activity, FolderOpen, ListChecks, ListTree, TerminalSquare, X } from 'lucide-react';
import type { ManagedServer } from '@agentdeck/shared/ssh';
import type { ConsoleServerTab, ConsoleView } from './console-state';

export const consoleViews = [
  { id: 'overview', label: '概览', Icon: Activity },
  { id: 'processes', label: '进程', Icon: ListTree },
  { id: 'jobs', label: '作业', Icon: ListChecks },
  { id: 'files', label: '文件', Icon: FolderOpen },
  { id: 'terminals', label: '终端', Icon: TerminalSquare },
] as const;

export function ConsoleServerTabs({
  tabs,
  servers,
  selected,
  select,
  close,
}: {
  tabs: ConsoleServerTab[];
  servers: ManagedServer[];
  selected?: string;
  select(id: string): void;
  close(id: string): void;
}) {
  if (!tabs.length) return null;
  return (
    <TabProvider
      selectedId={selected}
      setSelectedId={(id) => {
        if (id) select(id);
      }}
    >
      <TabList
        aria-label="服务器标签"
        className="conversation-tabs flex shrink-0 overflow-x-auto border-b border-border bg-sidebar"
      >
        {tabs.map((tab) => {
          const server = servers.find((item) => item.alias === tab.serverId);
          const active = selected === tab.serverId;
          return (
            <div
              key={tab.serverId}
              data-active={active || undefined}
              className="conversation-tab group flex min-w-28 max-w-60 shrink-0 items-center border-r border-border"
            >
              <Tab
                id={tab.serverId}
                aria-controls={`console-server-${encodeURIComponent(tab.serverId)}`}
                className="flex h-9 min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs font-medium outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive"
              >
                <span className="truncate">{server?.name ?? tab.serverId}</span>
              </Tab>
              <button
                type="button"
                className={`mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-control-hover hover:text-foreground focus-visible:outline-interactive ${active ? 'opacity-80 hover:opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100'}`}
                aria-label={`关闭服务器标签 ${server?.name ?? tab.serverId}`}
                title="关闭标签，保留服务器上的终端"
                onClick={() => close(tab.serverId)}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          );
        })}
      </TabList>
    </TabProvider>
  );
}

export function ConsoleViewTabs({
  view,
  prefix,
  select,
}: {
  view: ConsoleView;
  prefix: string;
  select(view: ConsoleView): void;
}) {
  return (
    <TabProvider
      selectedId={`${prefix}-${view}`}
      setSelectedId={(id) => {
        const selected = consoleViews.find((item) => `${prefix}-${item.id}` === id);
        if (selected) select(selected.id);
      }}
    >
      <TabList aria-label="SSH 控制台视图" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4">
        {consoleViews.map(({ id, label, Icon }) => (
          <Tab
            key={id}
            id={`${prefix}-${id}`}
            aria-controls={`${prefix}-panel`}
            className="flex h-10 items-center gap-1.5 border-b-2 border-transparent px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground aria-selected:border-interactive aria-selected:text-foreground focus-visible:outline-interactive"
          >
            <Icon aria-hidden className="size-3.5" />
            {label}
          </Tab>
        ))}
      </TabList>
    </TabProvider>
  );
}
