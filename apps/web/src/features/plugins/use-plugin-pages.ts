import { useEffect, useRef, useState } from 'react';
import { pluginPages, type WorkbenchPlugin, type WorkbenchPluginSessionContext } from '@agentdeck/shared/plugins';
import { useChat } from '../chat/state/chat-store';
import { useWorkbenchPlugins } from './use-workbench-plugins';

export type PluginInvocation = { id: string; sequence: number; session: WorkbenchPluginSessionContext };
const EMPTY_PLUGINS: WorkbenchPlugin[] = [];
function targetPage(plugin: WorkbenchPlugin, page?: string) {
  return page ?? pluginPages(plugin.manifest)[0]?.id ?? 'main';
}
export function currentPluginSession(): WorkbenchPluginSessionContext {
  const { conversationId, workspaceId, agent, sessionId, running } = useChat.getState();
  return { conversationId, workspaceId, agent, sessionId, running };
}

export function usePluginPages() {
  const [id, select] = useState<string>();
  const [managerOpen, setManagerOpen] = useState(false);
  const [pageId, setPageId] = useState('main');
  const counter = useRef(0);
  const [invocations, setInvocations] = useState<Record<string, PluginInvocation[]>>({});
  const [command, setCommand] = useState<{ pluginId: string; id: string; sequence: number }>();
  const show = (value?: string, page?: string) => {
    select(value);
    setPageId(page ?? 'main');
    setCommand(undefined);
  };
  const query = useWorkbenchPlugins();
  const list = query.data?.plugins ?? EMPTY_PLUGINS;
  const previous = useRef(list);
  useEffect(() => {
    if (previous.current === list) return;
    const old = previous.current;
    previous.current = list;
    setInvocations((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => {
          const entry = list.find((plugin) => plugin.enabled && plugin.manifest.id === id);
          const before = old.find((plugin) => plugin.manifest.id === id);
          return entry && before && entry.installedAt === before.installedAt;
        }),
      ),
    );
  }, [list]);
  const active = list.find((plugin) => plugin.manifest.id === id && plugin.enabled);
  const activePage = active
    ? (pluginPages(active.manifest).find((page) => page.id === pageId) ?? pluginPages(active.manifest)[0])
    : undefined;
  function run(pluginId: string, commandId: string) {
    const plugin = list.find((plugin) => plugin.enabled && plugin.manifest.id === pluginId);
    const entry = plugin?.manifest.commands.find((command) => command.id === commandId);
    if (!plugin || !entry) return false;
    if ((invocations[pluginId]?.length ?? 0) >= 32) return false;
    const invocation = { id: entry.id, sequence: ++counter.current, session: currentPluginSession() };
    setInvocations((current) => ({ ...current, [pluginId]: [...(current[pluginId] ?? []), invocation] }));
    if (entry.execution !== 'background') {
      select(pluginId);
      setPageId(targetPage(plugin, entry.page));
      setCommand({ pluginId, ...invocation });
    }
    return true;
  }
  const enabledPlugins = list.filter((plugin) => plugin.enabled);
  return {
    list,
    active,
    activePage,
    invocations,
    run,
    delivered: (pluginId: string, sequence: number) =>
      setInvocations((current) => ({
        ...current,
        [pluginId]: (current[pluginId] ?? []).filter((item) => item.sequence !== sequence),
      })),
    enabledPlugins,
    selected: active?.manifest.id,
    show,
    command: command?.pluginId === id ? command : undefined,
    managerOpen,
    setManagerOpen,
  };
}
