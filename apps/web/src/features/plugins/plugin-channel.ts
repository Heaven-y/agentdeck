import { z } from 'zod';
import type { WorkbenchPluginManifest } from '@agentdeck/shared/plugins';
import type { Workspace } from '@agentdeck/shared/projects';
import { useChat } from '../chat/state/chat-store';
import { handlePluginRequest } from './plugin-bridge';
import { createPluginUiServices } from './plugin-ui-services';

const Notice = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agentdeck.plugin.ready') }),
  z.object({ type: z.literal('agentdeck.plugin.command-error'), error: z.string().max(1000) }),
]);
function lifecycle(data: unknown, ready: () => void, manifest: WorkbenchPluginManifest) {
  const notice = Notice.safeParse(data);
  if (!notice.success) return false;
  if (notice.data.type === 'agentdeck.plugin.ready') ready();
  else useChat.setState({ banner: `${manifest.name}：${notice.data.error.slice(0, 500)}` });
  return true;
}
const RequestId = z.object({ type: z.string(), id: z.string().min(1).max(80) });
function available(controllers: Map<string, AbortController>, remaining: number, id: string) {
  return controllers.size < 16 && remaining > 0 && !controllers.has(id);
}
/** 每个文档一个通信通道；卸载时统一取消请求与计时器。 */
export function connectPluginChannel(options: {
  target(): Window | null | undefined;
  project(): Workspace | undefined;
  ready(): void;
  manifest: WorkbenchPluginManifest;
}) {
  const ui = createPluginUiServices();
  const controllers = new Map<string, AbortController>();
  let active = true,
    remaining = 60;
  const timer = setInterval(() => {
    remaining = 60;
  }, 1000);
  const receive = (event: MessageEvent<unknown>) => {
    const target = options.target();
    if (!target || event.source !== target) return;
    if (lifecycle(event.data, options.ready, options.manifest)) return;
    const parsed = RequestId.safeParse(event.data);
    if (!parsed.success) return;
    const data = parsed.data;
    if (data.type === 'agentdeck.plugin.cancel') {
      controllers.get(data.id)?.abort();
      return;
    }
    if (data.type !== 'agentdeck.plugin.request') return;
    if (!available(controllers, remaining, data.id)) return;
    remaining--;
    const controller = new AbortController();
    controllers.set(data.id, controller);
    void handlePluginRequest(options.manifest, event.data, {
      project: options.project(),
      signal: controller.signal,
      ui,
    })
      .then(
        (result) => {
          if (active) target.postMessage({ type: 'agentdeck.plugin.response', id: data.id, result }, '*');
        },
        (error: unknown) => {
          if (active)
            target.postMessage(
              {
                type: 'agentdeck.plugin.response',
                id: data.id,
                error: error instanceof Error ? error.message : '插件请求失败',
              },
              '*',
            );
        },
      )
      .finally(() => controllers.delete(data.id));
  };
  window.addEventListener('message', receive);
  return () => {
    active = false;
    for (const controller of controllers.values()) controller.abort();
    clearInterval(timer);
    window.removeEventListener('message', receive);
  };
}
