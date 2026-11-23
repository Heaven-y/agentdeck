// 对话 WebSocket：/ws（访问控制在 security.ts 的 onRequest 钩子里完成）
import type { FastifyInstance } from 'fastify';
import { ClientMessageSchema, ResumeRequestSchema } from '@agentdeck/shared/conversation';
import { z } from 'zod';
import type { Socket, TurnManager } from '../../chat/turn-manager';
import { ResumeHub } from '../../chat/resume-hub';

const WS_OPEN = 1;
const SendingIdentity = z.object({ type: z.literal('chat.send'), clientTurnId: z.string().min(1).max(200) });

function sendingIdentity(value: unknown): { clientTurnId?: string } {
  const parsed = SendingIdentity.safeParse(value);
  return parsed.success ? { clientTurnId: parsed.data.clientTurnId } : {};
}

/** ws 的消息可能是 Buffer、ArrayBuffer 或分片数组 */
function rawText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

export function registerWsRoutes(app: FastifyInstance, deps: { turns: TurnManager }): ResumeHub {
  const recovery = new ResumeHub(deps.turns);
  app.addHook('onClose', (_server, done) => {
    recovery.dispose();
    done();
  });
  app.get('/ws', { websocket: true }, (ws) => {
    const peer = {
      send: (data: string) => ws.send(data),
      isOpen: () => ws.readyState === WS_OPEN,
      close: () => ws.terminate(),
    };
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      if (peer.isOpen()) ws.ping();
    }, 15_000);
    heartbeat.unref();
    let socket: Socket | undefined;
    let rejected = false;
    const send = (message: Parameters<Socket['send']>[0]) =>
      socket ? socket.send(message) : peer.send(JSON.stringify(message));

    ws.on('message', (data) => {
      if (rejected) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText(data));
      } catch {
        send({ type: 'error', message: '消息不是合法的 JSON' });
        return;
      }
      if (!socket) {
        const resume = ResumeRequestSchema.safeParse(parsed);
        if (!resume.success) {
          rejected = true;
          send({ type: 'error', ...sendingIdentity(parsed), message: '请先建立会话连接。' });
          ws.close(1008);
          return;
        }
        socket = recovery.attach(peer, resume.data);
        rejected = !socket;
        return;
      }
      const active = socket;
      const msg = ClientMessageSchema.safeParse(parsed);
      if (!msg.success) {
        send({ type: 'error', ...sendingIdentity(parsed), message: '消息格式不正确' });
        return;
      }
      void recovery.handle(peer, active, msg.data).catch(() => {
        if (peer.isOpen())
          send({
            type: 'error',
            ...sendingIdentity(msg.data),
            message: '会话操作失败，请检查原生运行状态后重试',
          });
      });
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      if (socket) recovery.detach(peer, socket);
    });
  });
  return recovery;
}
