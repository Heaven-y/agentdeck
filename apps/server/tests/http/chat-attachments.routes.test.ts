import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../../src/http/app';
import { SESSION_COOKIE } from '../../src/http/security';
import { registerChatAttachmentRoutes } from '../../src/http/chat-attachments.routes';
import { AttachmentStore } from '../../src/chat/attachments';
import { SessionError } from '../../src/agents/errors';
it('上传与预览同时校验本机认证、页面恢复身份和原生会话，二进制不进入WS', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-attachment-http-'));
  const token = randomUUID(),
    instance = randomUUID(),
    owner = {};
  const release = vi.fn();
  const app = await buildApp({
    token: 'fixture',
    port: 4317,
    routes: (app) =>
      registerChatAttachmentRoutes(app, {
        attachments: new AttachmentStore(root),
        getWorkspace: async (id) => (id === 'project' ? { id, name: 'fixture', dir: root } : undefined),
        assertBelongs: async (_workspace, _agent, id) => {
          if (id !== 'native') throw new SessionError(404, 'session_missing', '会话不属于当前项目');
        },
        acquireWorkspace: () => release,
        recovery: { identity: (t, i) => (t === token && i === instance ? (owner as never) : undefined) },
      }),
  });
  const headers = {
    host: '127.0.0.1:4317',
    origin: 'http://127.0.0.1:4317',
    cookie: `${SESSION_COOKIE}=fixture`,
    'content-type': 'application/octet-stream',
    'x-agentdeck-owner': token,
    'x-agentdeck-instance': instance,
  };
  const query = new URLSearchParams({
    agent: 'claude',
    conversationId: 'draft',
    name: 'notes.txt',
    mimeType: 'text/plain',
  });
  const url = '/api/workspaces/project/chat-attachments?' + query.toString();
  try {
    expect(
      (await app.inject({ method: 'POST', url, headers: { ...headers, cookie: '' }, payload: Buffer.from('fixture') }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, origin: 'https://example.test' },
          payload: Buffer.from('fixture'),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'x-agentdeck-instance': randomUUID() },
          payload: Buffer.from('fixture'),
        })
      ).statusCode,
    ).toBe(409);
    const uploaded = await app.inject({ method: 'POST', url, headers, payload: Buffer.from('fixture') });
    expect(uploaded.statusCode).toBe(200);
    const asset = uploaded.json<{ id: string; revision: string }>();
    const readQuery = new URLSearchParams({ agent: 'claude', conversationId: 'draft', revision: asset.revision });
    const readUrl = `/api/workspaces/project/chat-attachments/${asset.id}?${readQuery.toString()}`;
    const read = await app.inject({ method: 'GET', url: readUrl, headers });
    expect(read.body).toBe('fixture');
    expect(read.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject({ method: 'GET', url: readUrl + '&sessionId=foreign', headers })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: Buffer.alloc(5 * 1024 * 1024 + 1) })).statusCode,
    ).toBe(413);
    expect(release).toHaveBeenCalled();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
