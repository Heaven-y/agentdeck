import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkbenchPlugin } from '@agentdeck/shared/plugins';
import type { Workspace } from '@agentdeck/shared/projects';
import { useUiPreferences } from '../../ui/appearance/ui-preferences';
import { pluginApi } from './plugin-api';
import { handlePluginRequest, pluginDocument } from './plugin-bridge';

function messageData(value: unknown): (Record<string, unknown> & { id: string }) | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (typeof data.id === 'string') return data as Record<string, unknown> & { id: string };
}
function acceptsRequest(requests: number, remaining: number, controllers: Map<string, AbortController>, id: string) {
  return requests < 16 && remaining > 0 && !controllers.has(id);
}

export default function PluginFrame({
  plugin,
  project,
  command,
  visible = true,
}: {
  plugin: WorkbenchPlugin;
  visible?: boolean;
  project?: Workspace;
  command?: { id: string; sequence: number };
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useUiPreferences((state) => state.theme);
  const currentProject = useRef(project);
  const context = useRef({ visible, theme });
  const sendContext = useCallback(() => {
    const styles = getComputedStyle(document.documentElement);
    const colors = Object.fromEntries(
      Array.from(styles)
        .filter((key) => key.startsWith('--color-'))
        .map((key) => [key, styles.getPropertyValue(key)]),
    );
    frame.current?.contentWindow?.postMessage(
      { type: 'agentdeck.plugin.context', context: { ...context.current, colors } },
      '*',
    );
  }, []);
  useEffect(() => {
    context.current = { visible, theme };
    sendContext();
  }, [visible, theme, sendContext]);
  const [htmlDocument, setDocument] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    currentProject.current = project;
  }, [project]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let requests = 0;
    const controllers = new Map<string, AbortController>();
    let remaining = 60;
    const timer = setInterval(() => {
      remaining = 60;
    }, 1000);
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = messageData(event.data);
      if (!data) return;
      if (data.type === 'agentdeck.plugin.cancel') {
        controllers.get(data.id)?.abort();
        return;
      }
      if (data.type !== 'agentdeck.plugin.request') return;
      if (!acceptsRequest(requests, remaining, controllers, data.id)) return;
      remaining--;
      const pendingId = data.id;
      const requestController = new AbortController();
      controllers.set(pendingId, requestController);
      const target = frame.current?.contentWindow;
      requests++;
      void handlePluginRequest(plugin.manifest, data, currentProject.current, requestController.signal)
        .then(
          (result) => {
            if (active) target?.postMessage({ type: 'agentdeck.plugin.response', id: data.id, result }, '*');
          },
          (reason: unknown) => {
            if (active)
              target?.postMessage(
                {
                  type: 'agentdeck.plugin.response',
                  id: data.id,
                  error: reason instanceof Error ? reason.message : '插件请求失败',
                },
                '*',
              );
          },
        )
        .finally(() => {
          requests--;
          controllers.delete(pendingId);
        });
    };
    window.addEventListener('message', receive);
    void pluginApi
      .page(plugin.manifest.id, controller.signal)
      .then((page) => {
        if (active) setDocument(pluginDocument(page.html, plugin.manifest.apiVersion));
      })
      .catch(() => {
        if (active) setError('插件页面无法加载，请核对插件是否已启用。');
      });
    return () => {
      active = false;
      controller.abort();
      for (const pending of controllers.values()) pending.abort();
      clearInterval(timer);
      window.removeEventListener('message', receive);
    };
  }, [plugin]);
  const sendCommand = () => {
    if (command) frame.current?.contentWindow?.postMessage({ type: 'agentdeck.plugin.command', id: command.id }, '*');
  };
  useEffect(sendCommand, [command]);
  if (error)
    return (
      <p role="alert" className="p-4 text-sm text-destructive-foreground">
        {error}
      </p>
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
      onLoad={() => {
        sendContext();
        sendCommand();
      }}
    />
  );
}
