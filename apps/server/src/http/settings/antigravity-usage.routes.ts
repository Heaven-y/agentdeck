import type { AntigravityOfficialUsage } from '@agentdeck/shared/conversation';
import type { AntigravityAccount } from '@agentdeck/shared/settings';
import type { FastifyInstance } from 'fastify';
import { SessionError } from '../../agents/errors';
import { requestSignal } from '../request-signal';

export function registerAntigravityAccountRoute(
  app: FastifyInstance,
  read: (signal: AbortSignal) => Promise<AntigravityAccount>,
): void {
  app.get('/api/settings/models/antigravity/account', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const signal = requestSignal(request, reply);
    const account = await read(signal).catch(() => ({}));
    return signal.aborted ? undefined : account;
  });
}

export function registerAntigravityUsageRoute(
  app: FastifyInstance,
  read: (signal: AbortSignal) => Promise<AntigravityOfficialUsage>,
): void {
  app.post(
    '/api/settings/models/antigravity/official-usage',
    {
      onSend: async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        return payload;
      },
      errorHandler(error, _request, reply) {
        if (reply.raw.destroyed) return;
        const status = error.statusCode;
        const failure =
          error instanceof SessionError
            ? error
            : status && status >= 400 && status < 500
              ? new SessionError(status, 'invalid_request', '额度查询请求格式不正确。')
              : new SessionError(503, 'antigravity_official_usage_unavailable', '暂时无法读取 Antigravity 官方额度。');
        void reply.code(failure.status).send({ code: failure.code, message: failure.message });
      },
    },
    async (request, reply) => {
      const signal = requestSignal(request, reply);
      const usage = await read(signal);
      return signal.aborted ? undefined : usage;
    },
  );
}
