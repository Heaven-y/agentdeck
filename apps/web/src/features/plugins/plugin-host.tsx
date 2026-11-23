import { createContext, useContext } from 'react';
import type { WorkbenchPlugin, WorkbenchPluginPageContribution } from '@agentdeck/shared/plugins';

type PluginHost = {
  plugins: WorkbenchPlugin[];
  open(plugin: WorkbenchPlugin, page: WorkbenchPluginPageContribution): void;
  run(plugin: WorkbenchPlugin, command: string): void;
};
export const PluginHostContext = createContext<PluginHost | null>(null);
export const usePluginHost = () => useContext(PluginHostContext);
