import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkbenchPlugin, WorkbenchPluginPageContribution } from '@agentdeck/shared/plugins';
import type { Workspace } from '@agentdeck/shared/projects';
import { useUiPreferences } from '../../ui/appearance/ui-preferences';
import { pluginApi } from './plugin-api';
import { pluginDocument } from './plugin-bridge';
import { connectPluginChannel } from './plugin-channel';
import { currentPluginSession, type PluginInvocation } from './use-plugin-pages';
import { useChat } from '../chat/state/chat-store';
import { pluginEvents } from './plugin-events';

type Props = {
  plugin: WorkbenchPlugin;
  visible?: boolean;
  project?: Workspace;
  page?: WorkbenchPluginPageContribution;
  invocations?: PluginInvocation[];
  delivered?(sequence: number): void;
};
export default function PluginFrame(props: Props) {
  const [generation, retry] = useState(0);
  return (
    <PluginDocumentFrame
      key={`${props.plugin.installedAt ?? 0}:${generation}`}
      {...props}
      retry={() => retry((value) => value + 1)}
    />
  );
}
function PluginDocumentFrame({
  plugin,
  project,
  visible = true,
  page,
  invocations = [],
  delivered,
  retry,
}: Props & { retry(): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useUiPreferences((state) => state.theme);
  const currentProject = useRef(project);
  const [ready, setReady] = useState(false);
  const context = useRef({ visible, theme, page });
  const sendContext = useCallback(() => {
    const styles = getComputedStyle(document.documentElement);
    const colors = Object.fromEntries(
      Array.from(styles)
        .filter((key) => key.startsWith('--color-'))
        .map((key) => [key, styles.getPropertyValue(key)]),
    );
    const session = currentPluginSession();
    const project = currentProject.current?.id === session.workspaceId ? currentProject.current : null;
    frame.current?.contentWindow?.postMessage(
      {
        type: 'agentdeck.plugin.context',
        context: {
          ...context.current,
          colors,
          ...(plugin.manifest.permissions.includes('session-context') ? { session } : {}),
          ...(plugin.manifest.permissions.includes('project-context') ? { project } : {}),
        },
      },
      '*',
    );
  }, [plugin]);
  useEffect(() => {
    context.current = { visible, theme, page };
    sendContext();
  }, [visible, theme, page, sendContext]);
  useEffect(() => {
    currentProject.current = project;
    sendContext();
  }, [project, sendContext]);
  const [htmlDocument, setDocument] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const manifest = plugin.manifest;
    if (manifest.apiVersion !== 2 || !manifest.events?.length) return;
    return useChat.subscribe((state, previous) => {
      for (const event of pluginEvents(state, previous)) {
        if (event.name === 'context.changed') sendContext();
        if (manifest.events?.includes(event.name))
          frame.current?.contentWindow?.postMessage({ type: 'agentdeck.plugin.event', event }, '*');
      }
    });
  }, [plugin, sendContext]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const disconnect = connectPluginChannel({
      manifest: plugin.manifest,
      target: () => frame.current?.contentWindow,
      project: () => currentProject.current,
      ready: () => {
        setReady(true);
        sendContext();
      },
    });
    void pluginApi
      .page(plugin.manifest.id, controller.signal)
      .then((value) => {
        if (active) setDocument(pluginDocument(value.html, plugin.manifest.apiVersion));
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '插件页面加载失败。');
      });
    return () => {
      active = false;
      controller.abort();
      disconnect();
    };
  }, [plugin, sendContext]);
  const sent = useRef(0);
  useEffect(() => {
    if (!ready) return;
    for (const invocation of invocations) {
      if (invocation.sequence <= sent.current) continue;
      sent.current = invocation.sequence;
      frame.current?.contentWindow?.postMessage(
        {
          type: 'agentdeck.plugin.command',
          id: invocation.id,
          sequence: invocation.sequence,
          conversationId: invocation.session.conversationId,
          ...(plugin.manifest.permissions.includes('session-context') ? { session: invocation.session } : {}),
        },
        '*',
      );
      delivered?.(invocation.sequence);
    }
  }, [ready, invocations, delivered, plugin]);
  if (error)
    return (
      <div className="p-4 text-sm">
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
        <button type="button" className="mt-2 underline" onClick={retry}>
          重试
        </button>
      </div>
    );
  if (!htmlDocument)
    return (
      <p role="status" className="p-4 text-sm">
        正在打开插件…
      </p>
    );
  return (
    <iframe
      ref={frame}
      title={plugin.manifest.name}
      srcDoc={htmlDocument}
      sandbox={plugin.manifest.apiVersion === 2 ? 'allow-scripts allow-forms' : 'allow-scripts'}
      referrerPolicy="no-referrer"
      className="h-full min-h-0 w-full border-0 bg-background"
      onLoad={sendContext}
    />
  );
}
