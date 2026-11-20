import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { AntigravityAcpClient } from '../../../../src/agents/antigravity/acp/client';

const roots: string[] = [];
const clients: AntigravityAcpClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(script: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-acp-client-'));
  roots.push(root);
  const file = path.join(root, 'fixture.cjs');
  await writeFile(file, script);
  const client = new AntigravityAcpClient({ cwd: root, command: { command: process.execPath, args: [file] } });
  clients.push(client);
  return client;
}
const lines =
  "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);";

it('真实stdio分块解码，原生请求与通知和响应分别派发', async () => {
  const client = await fixture(
    lines +
      "process.stderr.write('private-diagnostic'); const out=JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{text:'中文'}})+'\\n';process.stdout.write(out.slice(0,10));process.stdout.write(out.slice(10));});",
  );
  await expect(client.request('initialize', {})).resolves.toEqual({ text: '中文' });
  await client.close();
  await client.closed;
});
it('原生错误不回显诊断，非白名单方法不发送', async () => {
  const client = await fixture(
    lines +
      "console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32603,message:'token=private endpoint=https://private.invalid'}}));});",
  );
  await expect(client.request('authenticate', {})).rejects.toThrow('AGY 没有完成请求');
  await expect(client.request('execute/arbitrary', {})).rejects.toThrow('异常数据');
});
it('当前服务524保留安全说明，下一请求成功不携带旧错误', async () => {
  const client = await fixture(
    'let first=true;' +
      lines +
      "console.log(JSON.stringify(first?{jsonrpc:'2.0',id:msg.id,error:{code:-32603,message:'HTTP 524 token=private'}}:{jsonrpc:'2.0',id:msg.id,result:{ok:true}}));first=false;});",
  );
  await expect(client.request('session/prompt', {})).rejects.toThrow('524');
  await expect(client.request('initialize', {})).resolves.toEqual({ ok: true });
});
it('取消等待和超时清理请求，迟到回复不串到下一请求', async () => {
  const client = await fixture(
    lines + "setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{ok:true}})),80);});",
  );
  const abort = new AbortController();
  const pending = client.request('initialize', {}, { signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toThrow('中断');
  await expect(client.request('initialize', {}, { timeoutMs: 5 })).rejects.toThrow('超时');
  await expect(client.request('initialize', {}, { timeoutMs: 1000 })).resolves.toEqual({ ok: true });
});
it('畸形输出结束未完成请求，不能无限保留占用', async () => {
  const client = await fixture(lines + "console.log('not-json');});");
  await expect(client.request('initialize', {})).rejects.toThrow('异常数据');
  await client.closed;
});
it('原生通知与请求正常路由，答复仅返回原生ID，关闭释放悬挂请求', async () => {
  const client = await fixture(
    lines +
      "if(msg.method==='initialize'){console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s'}}));console.log(JSON.stringify({jsonrpc:'2.0',id:'ask',method:'session/request_permission',params:{sessionId:'s'}}));console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{ok:true}}));}});",
  );
  const notifications: string[] = [];
  const requests: string[] = [];
  client.onNotification = (method) => notifications.push(method);
  client.onRequest = (request) => {
    requests.push(request.method);
    client.respond(request.id, { outcome: { outcome: 'cancelled' } });
  };
  await client.request('initialize', {});
  expect(notifications).toEqual(['session/update']);
  expect(requests).toEqual(['session/request_permission']);
  client.reject('expired');
  client.notify('session/cancel', { sessionId: 's' });
  const pending = client.request('session/prompt', {}, { timeoutMs: 0 });
  const result = pending.catch((error: unknown) => error);
  await client.close();
  expect(await result).toMatchObject({ code: 'unavailable' });
});
it('原生不支持方法与启动失败可识别为不可用，已取消请求不写入', async () => {
  const client = await fixture(
    lines + "console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'private'}}));});",
  );
  await expect(client.request('session/resume', {})).rejects.toMatchObject({ code: 'unavailable' });
  const abort = new AbortController();
  abort.abort();
  await expect(client.request('initialize', {}, { signal: abort.signal })).rejects.toMatchObject({ code: 'cancelled' });
  const missing = new AntigravityAcpClient({
    cwd: roots[0]!,
    command: { command: path.join(roots[0]!, 'missing-executable'), args: [] },
  });
  clients.push(missing);
  await expect(missing.request('initialize', {})).rejects.toMatchObject({ code: 'unavailable' });
});
