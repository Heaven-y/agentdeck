import { z } from 'zod';
import {
  WorkbenchPluginBackendRequestSchema,
  WorkbenchPluginHostRequestSchema,
  type WorkbenchPluginManifest,
} from '@agentdeck/shared/plugins';
import type { PluginUiServices } from './plugin-ui-services';
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
    'host.request',
    'session.get',
    'composer.get',
    'composer.set',
  ]),
  params: z.unknown().optional(),
  conversationId: z.string().min(1).max(200).optional(),
});
const Storage = z.strictObject({ value: z.record(z.string(), z.json()), revision: z.string().max(80) });
const permissionByMethod = {
  'project.get': 'project-context',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'backend.request': 'backend',
  'clipboard.readText': 'clipboard',
  'clipboard.writeText': 'clipboard',
  'session.get': 'session-context',
  'composer.get': 'composer',
  'composer.set': 'composer',
} as const;
type RequestContext = { project?: Workspace; signal?: AbortSignal; ui?: PluginUiServices };

/** 插件后端请求只路由到该插件的进程，不能访问主应用其他接口。 */
export async function handlePluginRequest(
  manifest: WorkbenchPluginManifest,
  data: unknown,
  context: RequestContext = {},
) {
  const input = Request.parse(data);
  if (JSON.stringify(data).length > 65536) throw new Error('插件请求超过限制');
  if (input.method === 'host.request') {
    return hostRequest(manifest, input.params, context.signal);
  }
  const permission = permissionByMethod[input.method];
  if (!manifest.permissions.includes(permission)) throw new Error('插件未声明此权限');
  return dispatch(manifest, input, context);
}
function dispatch(
  manifest: WorkbenchPluginManifest,
  input: z.infer<typeof Request>,
  { project, signal, ui }: RequestContext,
) {
  switch (input.method) {
    case 'backend.request':
      return pluginApi.backend(manifest.id, WorkbenchPluginBackendRequestSchema.parse(input.params), signal);
    case 'clipboard.readText':
      return navigator.clipboard.readText();
    case 'clipboard.writeText':
      return navigator.clipboard.writeText(z.string().max(65536).parse(input.params));
    case 'project.get':
      return projectContext(project, ui);
    case 'storage.get':
      return pluginApi.storage(manifest.id);
    case 'storage.set':
      return pluginApi.saveStorage(manifest.id, Storage.parse(input.params));
    default:
      return uiRequest(input, ui);
  }
}
function projectContext(project?: Workspace, ui?: PluginUiServices) {
  if (!project || (ui && project.id !== ui.session().workspaceId)) return null;
  return { id: project.id, name: project.name, dir: project.dir };
}
function hostRequest(manifest: WorkbenchPluginManifest, params: unknown, signal?: AbortSignal) {
  const value = WorkbenchPluginHostRequestSchema.parse(params);
  const permission = value.method === 'projects.list' ? 'projects' : 'session-history';
  if (!manifest.permissions.includes(permission)) throw new Error('插件未声明此权限');
  return pluginApi.host(manifest.id, value, signal);
}
function uiRequest(input: z.infer<typeof Request>, ui?: PluginUiServices) {
  if (!ui) throw new Error('当前会话不可用');
  if (input.method === 'session.get') return ui.session();
  if (input.method === 'composer.get') return ui.readDraft(input.conversationId);
  return ui.writeDraft(input.params);
}

const POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none';";
/** 自包含文档在不含 same-origin 权限的 iframe 里运行，所有宿主调用经消息校验。 */
export function pluginDocument(html: string, version = 1) {
  const sdk = `(() => {
    const pending = new Map();
    const commands = new Set(), contexts = new Set(), events = new Map(), backlog = [];
    let queue = Promise.resolve(), conversationId;
    const deliver = (listener, command) => { queue = queue.then(async () => {
      conversationId = command.conversationId;
      try { await listener(command.id, command); }
      catch(error) { parent.postMessage({type:'agentdeck.plugin.command-error',error:error instanceof Error?error.message:'插件操作失败'},'*'); }
      finally { conversationId = undefined; }
    }); };
    addEventListener('message', event => {
      if (event.source !== parent) return;
      if(event.data?.type === 'agentdeck.plugin.context') {
        window.__agentdeckContext = event.data.context;
        for(const listener of contexts) listener(event.data.context);
        return;
      }
      if(event.data?.type === 'agentdeck.plugin.command') {
        if(commands.size) for(const listener of commands) deliver(listener, event.data); else backlog.push(event.data);
        return;
      }
      if(event.data?.type === 'agentdeck.plugin.event') {
        for(const listener of events.get(event.data.event.name) ?? []) Promise.resolve().then(() => listener(event.data.event)).catch(error => console.error(error));
        return;
      }
      if (event.data?.type !== 'agentdeck.plugin.response') return;
      const item = pending.get(event.data.id); if (!item) return;
      pending.delete(event.data.id); item.cleanup();
      event.data.error ? item.reject(new Error(event.data.error)) : item.resolve(event.data.result);
    });
    const request = (method, params, signal) => new Promise((resolve, reject) => {
      if(signal?.aborted) return reject(new DOMException('请求已取消', 'AbortError'));
      if (pending.size >= 16) return reject(new Error('请求过多'));
      const id = crypto.randomUUID();
      const abort = () => { pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort',abort); parent.postMessage({type:'agentdeck.plugin.cancel',id}, '*'); reject(new DOMException('请求已取消', 'AbortError')); };
      const timer = setTimeout(() => { abort(); }, 45000);
      signal?.addEventListener('abort',abort,{once:true});
      pending.set(id, {resolve, reject, cleanup:()=>{ clearTimeout(timer);signal?.removeEventListener('abort',abort); }});
      parent.postMessage({type:'agentdeck.plugin.request',id,method,params,conversationId}, '*');
    });
    Object.defineProperty(window, 'agentdeck', { value: Object.freeze({
      version: ${version},
      backend: Object.freeze({request: (params, options) => request('backend.request', params, options?.signal)}),
      host: Object.freeze({request: (params, options) => request('host.request',params,options?.signal)}),
      session: Object.freeze({get: () => request('session.get')}),
      composer: Object.freeze({get: () => request('composer.get'), set: value => request('composer.set',value)}),
      clipboard: Object.freeze({readText: () => request('clipboard.readText'), writeText: value => request('clipboard.writeText', value)}),
      onContext: listener => { contexts.add(listener); if(window.__agentdeckContext) listener(window.__agentdeckContext);
        return () => contexts.delete(listener); },
      storage: Object.freeze({get: () => request('storage.get'), set: value => request('storage.set', value)}),
      project: Object.freeze({get: () => request('project.get')}),
      onCommand: listener => { commands.add(listener); for(const command of backlog.splice(0)) deliver(listener,command); return () => commands.delete(listener); },
      onEvent: (name, listener) => { let group=events.get(name); if(!group) events.set(name,group=new Set()); group.add(listener); return () => {group.delete(listener);if(!group.size)events.delete(name);}; }
    }) });
    addEventListener('load', () => parent.postMessage({type:'agentdeck.plugin.ready'},'*'), {once:true});
  })();`;
  return `<meta http-equiv="Content-Security-Policy" content="${POLICY}"><script>${sdk}</script>${html}`;
}
