import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionReferences } from '../../src/sessions/references';
import { formatSessionReference } from '@agentdeck/shared/conversation';
import * as codexHistory from '../../src/agents/codex/history/sessions';
import { SessionError } from '../../src/agents/errors';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-reference-'));
  roots.push(root);
  const workspace = { id: 'project-b', name: '引用来源', dir: path.join(root, 'project') };
  await mkdir(workspace.dir);
  const file = path.join(root, 'native.jsonl');
  await writeFile(file, '{"type":"user","text":"原生正文留在原文件"}\n');
  const assertBelongs = vi.fn(async () => workspace);
  const read = vi.fn();
  const sessions = { assertBelongs, read };
  vi.spyOn(codexHistory, 'codexSessionRecordPath').mockResolvedValue(file);
  const service = createSessionReferences({
    configDir: root,
    store: { get: async (id) => (id === workspace.id ? workspace : undefined) },
    sessions,
    environment: async () => ({}),
  });
  const reference = formatSessionReference({ workspaceId: workspace.id, agent: 'codex', sessionId: 'native-b' });
  return { service, workspace, file, assertBelongs, read, reference };
}
it('引用只附原生位置与读取说明，不读取正文或复制历史，重复链接只定位一次', async () => {
  const f = await fixture();
  const input = `请参考 ${f.reference}，引用仍是 ${f.reference}`;
  const result = await f.service.prepare(input);
  expect(result.startsWith(input)).toBe(true);
  expect(result).toContain(JSON.stringify(f.file));
  expect(result).toContain('JSONL');
  expect(result).not.toContain('原生正文留在原文件');
  expect(await readFile(f.file, 'utf8')).toContain('原生正文留在原文件');
  expect(f.read).not.toHaveBeenCalled();
  expect(f.assertBelongs).toHaveBeenCalledExactlyOnceWith(f.workspace, 'codex', 'native-b', undefined);
});
it('引用归属错误单独说明，不修改原输入，也不把 B 当作当前会话身份', async () => {
  const f = await fixture();
  f.assertBelongs.mockRejectedValueOnce(new SessionError(404, 'session_missing', '引用的会话不在这个工作区。'));
  const result = await f.service.prepare(f.reference);
  expect(result.startsWith(f.reference)).toBe(true);
  expect(result).toContain('读取失败：引用的会话不在这个工作区。');
  expect(codexHistory.codexSessionRecordPath).not.toHaveBeenCalled();
});
it('普通链接不增加准备工作，中断后不继续定位或投递', async () => {
  const f = await fixture();
  expect(await f.service.prepare('参考 https://example.com/guide')).toBe('参考 https://example.com/guide');
  expect(f.assertBelongs).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(f.service.prepare(f.reference, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.assertBelongs).not.toHaveBeenCalled();
});
