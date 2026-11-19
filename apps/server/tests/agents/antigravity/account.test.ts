import { expect, it } from 'vitest';
import { antigravityAccountFromStatus } from '../../../src/agents/antigravity/account';

it('仅保留原生官方账号邮箱，空状态、系统用户名和 ADC 不能冒充 Google 账号', () => {
  const email = 'developer@example.invalid';
  expect(antigravityAccountFromStatus({ userStatus: { email, name: '示例', accessToken: 'fixture-only' } })).toEqual({
    email,
  });
  for (const payload of [{ userStatus: {} }, { email }, { username: email }, { userStatus: { email, isAdc: true } }])
    expect(antigravityAccountFromStatus(payload)).toEqual({});
});
