import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createWorkbenchPlugins } from '../../src/plugins/service';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const backend = `const fs=require('node:fs/promises'),path=require('node:path');let context,canceled=false;
process.on('message',async(message)=>{const {id,type,input}=message;const reply=value=>process.send({id,ok:true,value});
 if(type==='host.response'){process.send({id:id.slice(5),ok:true,value:{status:200,body:message.ok?message.value:message.message}});return;}
 if(type==='initialize'){context=input;reply(null);}
 else if(type==='cancel'){canceled=true;process.send({type:'host.cancel',id:'host-'+id});}
 else if(type==='dispose'){reply(null);}
 else if(input.url==='/wait'){await fs.writeFile(path.join(context.dataDir,'waiting'),'yes');}
 else if(input.url==='/save'){await fs.writeFile(path.join(context.dataDir,'value'),input.body.value);reply({status:200,body:null});}
 else if(input.url==='/projects'){process.send({type:'host.request',id:'host-'+id,input:{method:'projects.list'}});}
 else {reply({status:200,body:{pid:process.pid,canceled,secret:!!process.env.AGENTDECK_FIXTURE_SECRET,value:await fs.readFile(path.join(context.dataDir,'value'),'utf8').catch(()=>null)}});}});
process.on('disconnect',()=>process.exit(0));`;
async function fixture(host?: Parameters<typeof createWorkbenchPlugins>[0]['host'], permissions = ['backend']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-process-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'source');
  await mkdir(directory);
  const manifest = {
    id: 'fixture',
    name: '测试服务',
    version: '1.0.0',
    apiVersion: 2,
    entry: 'index.html',
    backend: 'backend.cjs',
    permissions,
  };
  await writeFile(path.join(directory, 'agentdeck.plugin.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'index.html'), '<p>测试服务</p>');
  await writeFile(path.join(directory, 'backend.cjs'), backend);
  const configDir = path.join(root, 'config');
  const service = createWorkbenchPlugins({ configDir, host });
  cleanups.push(() => service.dispose());
  const installed = await service.install({ directory });
  return { root, directory, manifest, configDir, service, installed };
}
it('插件按需启动独立进程，更新与重装保留自有数据，卸载后不能调用', async () => {
  const f = await fixture();
  const data = path.join(f.configDir, 'workbench-plugins', 'data', 'fixture', 'value');
  await expect(readFile(data)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(f.service.backend('fixture', { method: 'GET', url: '/' })).rejects.toMatchObject({
    code: 'plugin_disabled',
  });
  const enabled = await f.service.update('fixture', { enabled: true, revision: f.installed.revision });
  await f.service.backend('fixture', { method: 'POST', url: '/save', body: { value: 'fixture-fact' } });
  const first = (await f.service.backend('fixture', { method: 'GET', url: '/' })).body as {
    pid: number;
    value: string;
  };
  expect(first.pid).not.toBe(process.pid);
  expect(first.value).toBe('fixture-fact');
  await writeFile(path.join(f.directory, 'agentdeck.plugin.json'), JSON.stringify({ ...f.manifest, version: '1.0.1' }));
  const updated = await f.service.install({ directory: f.directory, revision: enabled.revision });
  expect(updated.plugins[0]?.enabled).toBe(true);
  const next = (await f.service.backend('fixture', { method: 'GET', url: '/' })).body as typeof first;
  expect(next.pid).not.toBe(first.pid);
  expect(next.value).toBe(first.value);
  await f.service.remove('fixture', { revision: updated.revision });
  expect(await readFile(data, 'utf8')).toBe('fixture-fact');
  await expect(f.service.backend('fixture', { method: 'GET', url: '/' })).rejects.toMatchObject({
    code: 'plugin_missing',
  });
  const installed = await f.service.install({ directory: f.directory });
  await f.service.update('fixture', { enabled: true, revision: installed.revision });
  expect((await f.service.backend('fixture', { method: 'GET', url: '/' })).body).toMatchObject({
    value: 'fixture-fact',
  });
});
it('取消传到插件进程，停用释放运行服务且不继承无关凭据', async () => {
  const f = await fixture();
  await f.service.update('fixture', { enabled: true, revision: f.installed.revision });
  process.env.AGENTDECK_FIXTURE_SECRET = 'synthetic-secret';
  try {
    expect((await f.service.backend('fixture', { method: 'GET', url: '/' })).body).toMatchObject({ secret: false });
  } finally {
    delete process.env.AGENTDECK_FIXTURE_SECRET;
  }
  const controller = new AbortController();
  const waiting = f.service
    .backend('fixture', { method: 'GET', url: '/wait' }, controller.signal)
    .catch((error: unknown) => error);
  const file = path.join(f.configDir, 'workbench-plugins', 'data', 'fixture', 'waiting');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await readFile(file).then(
        () => true,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  await waiting;
  expect((await f.service.backend('fixture', { method: 'GET', url: '/' })).body).toMatchObject({ canceled: true });
  const list = await f.service.list();
  await f.service.update('fixture', { enabled: false, revision: list.revision });
  await expect(f.service.backend('fixture', { method: 'GET', url: '/' })).rejects.toMatchObject({
    code: 'plugin_disabled',
  });
});
it('整个插件包的摘要阻止执行安装后替换的后端', async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.configDir, 'workbench-plugins', 'packages', 'fixture', 'backend.cjs'),
    'throw new Error("replaced")',
  );
  await expect(f.service.update('fixture', { enabled: true, revision: f.installed.revision })).rejects.toMatchObject({
    code: 'unsafe_path',
  });
});
it('后端经同一宿主接口调用项目服务，缺权限时不执行，增加权限后重新启用才生效', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return [{ id: 'project' }];
  });
  const enabled = await f.service.update('fixture', { enabled: true, revision: f.installed.revision });
  const denied = await f.service.backend('fixture', { method: 'GET', url: '/projects' });
  expect(denied.body).toContain('权限');
  expect(calls).toBe(0);
  await writeFile(
    path.join(f.directory, 'agentdeck.plugin.json'),
    JSON.stringify({ ...f.manifest, permissions: ['backend', 'projects'] }),
  );
  const updated = await f.service.install({ directory: f.directory, revision: enabled.revision });
  expect(updated.plugins[0]?.enabled).toBe(false);
  await f.service.update('fixture', { enabled: true, revision: updated.revision });
  expect((await f.service.backend('fixture', { method: 'GET', url: '/projects' })).body).toEqual([{ id: 'project' }]);
  expect(calls).toBe(1);
});
it('页面取消后端请求后，反向调用的原生宿主读取也收到取消', async () => {
  let started!: () => void, canceled!: () => void;
  const hostStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hostCanceled = new Promise<void>((resolve) => {
    canceled = resolve;
  });
  const f = await fixture(
    async (_input, signal) => {
      started();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      canceled();
      signal?.throwIfAborted();
      return [];
    },
    ['backend', 'projects'],
  );
  await f.service.update('fixture', { enabled: true, revision: f.installed.revision });
  const controller = new AbortController();
  const result = f.service
    .backend('fixture', { method: 'GET', url: '/projects' }, controller.signal)
    .catch((error: unknown) => error);
  await hostStarted;
  controller.abort();
  await hostCanceled;
  expect(await result).toBeInstanceOf(Error);
});
