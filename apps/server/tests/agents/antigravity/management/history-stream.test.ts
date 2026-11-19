import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { readInitialAgentUpdate } from '../../../../src/agents/antigravity/management/history-stream';

function envelope(value: unknown, flags = 0) {
  const data = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}

it('原生分页只取首帧并关闭订阅，支持跨块帧头/正文；拒绝超限和协议终端错误', async () => {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (value: Buffer) => chunks.push(value));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      expect(request.url).toMatch(/\/StreamAgentStateUpdates$/);
      expect(request.headers['content-type']).toBe('application/connect+json');
      expect(body.readUInt32BE(1)).toBe(body.length - 5);
      const params = JSON.parse(body.subarray(5).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/connect+json' });
      if (params.conversationId === 'unsupported') {
        response.end(envelope({ error: { code: 'unimplemented', message: '不要返回原始诊断' } }, 2));
        return;
      }
      if (params.conversationId === 'large') {
        const header = Buffer.alloc(5);
        header.writeUInt32BE(33 * 1024 * 1024, 1);
        response.write(header);
        return;
      }
      const page = envelope({ update: { conversationId: params.conversationId, sequence: 1 } });
      response.write(page.subarray(0, 2));
      setImmediate(() => {
        if (!response.destroyed)
          response.write(Buffer.concat([page.subarray(2), envelope({ update: { sequence: 2 } })]));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await expect(readInitialAgentUpdate(port, { conversationId: 'first' })).resolves.toEqual({
      conversationId: 'first',
      sequence: 1,
    });
    await expect(readInitialAgentUpdate(port, { conversationId: 'large' })).rejects.toMatchObject({
      code: 'session_history_page_too_large',
    });
    await expect(readInitialAgentUpdate(port, { conversationId: 'unsupported' })).rejects.toMatchObject({
      code: 'session_history_paging_unavailable',
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
