import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  fetchCodexOfficialUsage,
  readCodexAccountScope,
  readCodexOfficialUsage,
} from '../../../src/agents/codex/account';
import { CodexClient } from '../../../src/agents/codex/run/client';

afterEach(() => vi.restoreAllMocks());

it('自定义服务、API Key 或自定义地址不进入账号分支，更不会调用配额', async () => {
  const client = { request: vi.fn() };
  await expect(readCodexAccountScope(client, { model_provider: 'relay' }, {})).resolves.toBeUndefined();
  await expect(readCodexAccountScope(client, {}, { OPENAI_API_KEY: 'fixture-only' })).resolves.toBeUndefined();
  await expect(
    readCodexAccountScope(client, { openai_base_url: 'https://api.example.invalid' }, {}),
  ).resolves.toBeUndefined();
  await expect(
    readCodexAccountScope(client, { chatgpt_base_url: 'https://api.example.invalid' }, {}),
  ).resolves.toBeUndefined();
  expect(client.request).not.toHaveBeenCalled();
  client.request.mockResolvedValueOnce({ config: { model_provider: 'relay' } });
  await expect(fetchCodexOfficialUsage(client, 'demo', {})).rejects.toMatchObject({
    code: 'codex_official_usage_account_required',
  });
  expect(client.request.mock.calls).toEqual([['config/read', { cwd: 'demo', includeLayers: false }]]);
});

it('已核实的 ChatGPT 原生登录仅只读账号和额度，保留未知字段且不暴露账号信息', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      config: { model_provider: 'openai', chatgpt_base_url: 'https://chatgpt.com/backend-api/' },
    })
    .mockResolvedValueOnce({ requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'sample@example.invalid' } })
    .mockResolvedValueOnce({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: 1800000000 },
          secondary: { usedPercent: null },
        },
      },
    });
  const report = await fetchCodexOfficialUsage({ request }, 'demo', {});
  expect(request.mock.calls).toEqual([
    ['config/read', { cwd: 'demo', includeLayers: false }],
    ['account/read', { refreshToken: false }],
    ['account/rateLimits/read', {}],
  ]);
  expect(report.groups).toEqual([
    {
      name: 'Codex',
      buckets: [
        {
          id: 'codex:primary',
          name: '主要额度窗口',
          window: '300 分钟',
          remainingFraction: 0.25,
          resetAt: '2027-01-15T08:00:00.000Z',
        },
        { id: 'codex:secondary', name: '次要额度窗口' },
      ],
    },
  ]);
  expect(JSON.stringify(report)).not.toContain('sample@example.invalid');
});

it.each(['成功', '读取失败', '取消'])('官方额度读取%s时均关闭只读实例，不把失败当作空额度', async (mode) => {
  const controller = new AbortController();
  const failure = new Error('fixture-usage-failure');
  const initialize = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const request = vi.fn(async (method: string) => {
    if (method === 'config/read') return { config: { model_provider: 'openai' } };
    if (method === 'account/read') return { requiresOpenaiAuth: true, account: { type: 'chatgpt' } };
    if (mode === '读取失败') throw failure;
    if (mode === '取消') controller.abort(failure);
    return { rateLimits: { primary: { usedPercent: 20 } } };
  });
  const start = vi
    .spyOn(CodexClient, 'start')
    .mockResolvedValue({ initialize, request, close } as unknown as CodexClient);
  const dir = path.join(tmpdir(), 'codex-usage-fixture');
  const pending = readCodexOfficialUsage(dir, {
    signal: controller.signal,
    env: { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, OPENAI_BASE_URL: undefined },
  });
  if (mode === '成功')
    await expect(pending).resolves.toMatchObject({ groups: [{ buckets: [{ remainingFraction: 0.8 }] }] });
  else await expect(pending).rejects.toBe(failure);
  expect(initialize).toHaveBeenCalledOnce();
  expect(start.mock.calls[0]?.[0]).toMatchObject({ cwd: dir, signal: expect.any(AbortSignal) });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'config/read',
    'account/read',
    'account/rateLimits/read',
  ]);
  expect(close).toHaveBeenCalledOnce();
});

it('账号读取失败时不继续请求额度，未知账号信息不能当作官方登录', async () => {
  const request = vi
    .fn<(method: string) => Promise<Record<string, unknown>>>()
    .mockRejectedValue(new Error('fixture-account-failure'));
  await expect(readCodexAccountScope({ request }, {}, {})).resolves.toBeUndefined();
  request.mockReset().mockResolvedValueOnce({ config: {} }).mockRejectedValueOnce(new Error('fixture-account-failure'));
  await expect(fetchCodexOfficialUsage({ request }, 'demo', {})).rejects.toMatchObject({
    code: 'codex_official_usage_account_required',
  });
  expect(request.mock.calls.map(([method]) => method)).toEqual(['config/read', 'account/read']);
});
