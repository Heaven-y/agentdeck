import { z } from 'zod';
import { WorkbenchPluginBackendRequestSchema, type WorkbenchPluginManifest } from '@agentdeck/shared/plugins';
import type { Workspace } from '@agentdeck/shared/projects';
import { pluginApi } from './plugin-api';

const Request = z.strictObject({
  type: z.literal('agentdeck.plugin.request'),
  id: z.string().min(1).max(80),
  method: z.enum([
    'storage.get',
    'storage.set',
    'project.get',
    'backend.request',
    'clipboard.readText',
    'clipboard.writeText',
  ]),
  params: z.unknown().optional(),
});
const Storage = z.strictObject({ value: z.record(z.string(), z.json()), revision: z.string().max(80) });
const permissionByMethod = {
  'project.get': 'project-context',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'backend.request': 'backend',
  'clipboard.readText': 'clipboard',
  'clipboard.writeText': 'clipboard',
} as const;

/** 插件后端请求只路由到该插件的进程，不能访问主应用其他接口。 */
export async function handlePluginRequest(
  manifest: WorkbenchPluginManifest,
  data: unknown,
  project?: Workspace,
  signal?: AbortSignal,
) {
  const input = Request.parse(data);
  if (JSON.stringify(data).length > 65536) throw new Error('插件请求超过限制');
  const permission = permissionByMethod[input.method];
  if (!manifest.permissions.includes(permission)) throw new Error('插件未声明此权限');
  switch (input.method) {
    case 'backend.request':
      return pluginApi.backend(manifest.id, WorkbenchPluginBackendRequestSchema.parse(input.params), signal);
    case 'clipboard.readText':
      return navigator.clipboard.readText();
    case 'clipboard.writeText':
      return navigator.clipboard.writeText(z.string().max(65536).parse(input.params));
    case 'project.get':
      return project ? { id: project.id, name: project.name, dir: project.dir } : null;
    case 'storage.get':
      return pluginApi.storage(manifest.id);
    case 'storage.set':
      return pluginApi.saveStorage(manifest.id, Storage.parse(input.params));
  }
}

const POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none';";
/** 自包含文档在不含 same-origin 权限的 iframe 里运行，所有宿主调用经消息校验。 */
export function pluginDocument(html: string, version = 1) {
  const sdk = `(() => {
    const pending = new Map();
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.type !== 'agentdeck.plugin.response') return;
      const item = pending.get(event.data.id); if (!item) return;
      pending.delete(event.data.id); item.cleanup();
      event.data.error ? item.reject(new Error(event.data.error)) : item.resolve(event.data.result);
    });
    const request = (method, params, signal) => new Promise((resolve, reject) => {
      if(signal?.aborted) return reject(new DOMException('请求已取消', 'AbortError'));
      if (pending.size >= 16) return reject(new Error('请求过多'));
      const id = crypto.randomUUID();
      const abort = () => { pending.delete(id); clearTimeout(timer); parent.postMessage({type:'agentdeck.plugin.cancel',id}, '*'); reject(new DOMException('请求已取消', 'AbortError')); };
      const timer = setTimeout(() => { abort(); }, 45000);
      signal?.addEventListener('abort',abort,{once:true});
      pending.set(id, {resolve, reject, cleanup:()=>{ clearTimeout(timer);signal?.removeEventListener('abort',abort); }});
      parent.postMessage({type:'agentdeck.plugin.request',id,method,params}, '*');
    });
    Object.defineProperty(window, 'agentdeck', { value: Object.freeze({
      version: ${version},
      backend: Object.freeze({request: (params, options) => request('backend.request', params, options?.signal)}),
      clipboard: Object.freeze({readText: () => request('clipboard.readText'), writeText: value => request('clipboard.writeText', value)}),
      onContext: listener => { const callback = event => {
        if(event.source === parent && event.data?.type === 'agentdeck.plugin.context') { window.__agentdeckContext = event.data.context; listener(event.data.context); }
      }; addEventListener('message', callback); if(window.__agentdeckContext) listener(window.__agentdeckContext);
        return () => removeEventListener('message', callback); },
      storage: Object.freeze({get: () => request('storage.get'), set: value => request('storage.set', value)}),
      project: Object.freeze({get: () => request('project.get')}),
      onCommand: listener => { const callback = event => {
        if(event.source === parent && event.data?.type === 'agentdeck.plugin.command') listener(event.data.id);
      }; addEventListener('message', callback); return () => removeEventListener('message', callback); }
    }) });
  })();`;
  return `<meta http-equiv="Content-Security-Policy" content="${POLICY}"><script>${sdk}</script>${html}`;
}
