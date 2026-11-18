import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerModelSettingsRoutes } from '../../../src/http/settings/model-settings.routes';

it('模型配置拒绝路径参数和未知请求体，响应不缓存且解析错误不泄漏正文', async () => {
  const app = Fastify();
  const read = vi.fn();
  const save = vi.fn();
  const contextWindow = vi.fn(async () => ({ model: 'Custom', windowTokens: 1000000 }));
  const readSecret = vi.fn(async () => ({ value: 'synthetic-key' }));
  registerModelSettingsRoutes(app, { read, save, contextWindow, readSecret });
  try {
    for (const url of ['/api/settings/models/unknown', '/api/settings/models/codex?path=elsewhere']) {
      const result = await app.inject({ url });
      expect(result.statusCode).toBe(400);
      expect(result.headers['cache-control']).toBe('no-store');
    }
    for (const payload of ['{"secret-body"', '{"revision":"missing","changes":{},"path":"secret-path"}']) {
      const result = await app.inject({
        method: 'PUT',
        url: '/api/settings/models/codex',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(result.statusCode).toBe(400);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).not.toContain('secret-');
    }
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    for (const payload of [
      { revision: 'missing', key: 'baseUrl' },
      { revision: 'missing', key: 'apiKey', path: 'elsewhere' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/settings/models/codex/secret', payload });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(readSecret).not.toHaveBeenCalled();
    const revealed = await app.inject({
      method: 'POST',
      url: '/api/settings/models/codex/secret',
      payload: { revision: 'missing', key: 'apiKey', provider: 'demo' },
    });
    expect(revealed.json()).toEqual({ value: 'synthetic-key' });
    expect(revealed.headers['cache-control']).toBe('no-store');
    expect(readSecret).toHaveBeenCalledExactlyOnceWith('codex', {
      revision: 'missing',
      key: 'apiKey',
      provider: 'demo',
    });
    const window = await app.inject({ url: '/api/settings/models/antigravity/context-window?model=custom-id' });
    expect(window.json()).toEqual({ model: 'Custom', windowTokens: 1000000 });
    expect(window.headers['cache-control']).toBe('no-store');
    expect(contextWindow).toHaveBeenCalledWith('antigravity', 'custom-id');
    expect(
      (await app.inject({ url: '/api/settings/models/antigravity/context-window?path=elsewhere' })).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
