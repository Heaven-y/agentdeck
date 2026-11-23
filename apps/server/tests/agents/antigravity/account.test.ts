import { expect, it, vi } from 'vitest';
import { antigravityAccountFromStatus, readAntigravityAccount } from '../../../src/agents/antigravity/account';
import { startManagementBackend } from '../../../src/agents/antigravity/management/management-process';
import { readAntigravityConnection } from '../../../src/agents/antigravity/models/model-catalog';

vi.mock('../../../src/agents/antigravity/management/management-process', () => ({ startManagementBackend: vi.fn() }));
vi.mock('../../../src/agents/antigravity/models/model-catalog', () => ({ readAntigravityConnection: vi.fn() }));

it('仅保留原生官方账号邮箱，空状态、系统用户名和 ADC 不能冒充 Google 账号', () => {
  const email = 'developer@example.invalid';
  expect(antigravityAccountFromStatus({ userStatus: { email, name: '示例', accessToken: 'fixture-only' } })).toEqual({
    email,
  });
  for (const payload of [{ userStatus: {} }, { email }, { username: email }, { userStatus: { email, isAdc: true } }])
    expect(antigravityAccountFromStatus(payload)).toEqual({});
});

it.each([true, false])('等原生会话列表就绪后只读取一次邮箱（存在：%s）', async (signedIn) => {
  const email = 'signed-in@example.invalid';
  const request = vi
    .fn()
    .mockResolvedValueOnce({ userStatus: signedIn ? { email } : {} })
    .mockResolvedValueOnce({ userStatus: { email: 'unexpected@example.invalid' } });
  const close = vi.fn(async () => undefined);
  vi.mocked(readAntigravityConnection).mockResolvedValue('account');
  vi.mocked(startManagementBackend).mockResolvedValue({ request, close });
  await expect(readAntigravityAccount()).resolves.toEqual(signedIn ? { email } : {});
  expect(startManagementBackend).toHaveBeenCalledOnce();
  expect(vi.mocked(startManagementBackend).mock.calls[0]?.[0].waitForSessionList).toBe(true);
  expect(request.mock.calls).toEqual([['GetUserStatus', {}, 'page']]);
  expect(close).toHaveBeenCalledOnce();
});
