import { expect, it, vi } from 'vitest';
import { fetchCodexOfficialUsage, readCodexAccountScope } from '../../../src/agents/codex/account';

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
