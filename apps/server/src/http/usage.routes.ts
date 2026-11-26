import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UsagePricesSchema, UsageQuerySchema } from '@agentdeck/shared/usage';
import type { createUsageService } from '../usage/service';
import { requestSignal } from './request-signal';

export function registerUsageRoutes(app: FastifyInstance, service: ReturnType<typeof createUsageService>) {
  app.get('/api/usage', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = UsageQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ message: '用量筛选参数不正确。' });
    return service.report(query.data, requestSignal(req, reply));
  });
  app.post('/api/usage/sync', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = z.object({ id: z.string().uuid().optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ message: '同步请求格式不正确。' });
    return service.sync(body.data.id, requestSignal(req, reply));
  });
  app.put('/api/usage/prices', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = UsagePricesSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ message: '请填写有效的模型单价。' });
    await service.savePrices(body.data.prices);
    return { prices: body.data.prices };
  });
}
