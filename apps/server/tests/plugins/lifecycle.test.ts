import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createWorkbenchPlugins } from '../../src/plugins/service';

it('声明生命周期的插件在停用和删除前收到通知，停用后的关联清理仍有效', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-lifecycle-'));
  const source = path.join(root, 'source');
  const configDir = path.join(root, 'config');
  await mkdir(source);
  const data = path.join(configDir, 'workbench-plugins', 'data', 'lifecycle', 'events.jsonl');
  await writeFile(
    path.join(source, 'agentdeck.plugin.json'),
    JSON.stringify({
      id: 'lifecycle',
      name: '生命周期',
      version: '1.0.0',
      apiVersion: 2,
      entry: 'index.html',
      backend: 'backend.cjs',
      sessionLifecycle: true,
      permissions: ['backend', 'session-control'],
      contributes: { nativeCommands: [{ agent: 'antigravity', name: 'with-codex' }] },
    }),
  );
  await writeFile(path.join(source, 'index.html'), '<p>生命周期</p>');
  await writeFile(
    path.join(source, 'backend.cjs'),
    `const fs=require('node:fs/promises'),path=require('node:path');let ctx;
process.on('message',async({id,type,input})=>{let value=null;if(type==='initialize')ctx=input;
if(type==='request'){await fs.appendFile(path.join(ctx.dataDir,'events.jsonl'),JSON.stringify(input.body)+'\\n');value={status:200,body:{}};}
process.send({id,ok:true,value});});process.on('disconnect',()=>process.exit(0));`,
  );
  const service = createWorkbenchPlugins({ configDir });
  try {
    const installed = await service.install({ directory: source });
    expect(await service.nativeCommand('antigravity', 'with-codex')).toBe(false);
    const enabled = await service.update('lifecycle', { enabled: true, revision: installed.revision });
    expect(await service.nativeCommand('antigravity', 'with-codex')).toBe(true);
    expect(await service.nativeCommand('codex', 'with-codex')).toBe(false);
    expect(await service.nativeCommand('antigravity', 'unknown')).toBe(false);
    await service.update('lifecycle', { enabled: false, revision: enabled.revision });
    expect(await service.nativeCommand('antigravity', 'with-codex')).toBe(false);
    await service.beforeSessionDelete({ agent: 'antigravity', sessionId: 'native-session', cwd: root });
    const events = (await readFile(data, 'utf8'))
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(events).toEqual([
      { event: 'disable' },
      { event: 'session.deleting', session: { agent: 'antigravity', sessionId: 'native-session', cwd: root } },
    ]);
  } finally {
    await service.dispose();
  }
});
