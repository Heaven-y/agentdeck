import { chmod, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { readAntigravityOfficialUsage } from '../../../src/agents/antigravity/usage/official-usage';
import { registerAntigravityUsageRoute } from '../../../src/http/settings/antigravity-usage.routes';

const url = '/api/settings/models/antigravity/official-usage';
const usageArgs = ['-p', '/usage', '--output-format', 'json'];
const privateDiagnostic = 'fixture-private-diagnostic';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const report = (groups: unknown) => ({ status: 'SUCCESS', command: { name: 'usage', data: { groups } } });

type Fixture = { settings?: object; version?: string; payload?: object; exitCode?: number; switchProvider?: boolean };

async function localCli({
  settings = {},
  version = '1.1.11',
  payload = report([]),
  exitCode = 0,
  switchProvider,
}: Fixture = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'agentdeck-agy-usage-test-'));
  cleanup.push(() => rmdir(homeDir));
  const gemini = path.join(homeDir, '.gemini');
  const native = path.join(gemini, 'antigravity-cli');
  for (const dir of [gemini, native]) {
    await mkdir(dir);
    cleanup.push(() => rmdir(dir));
  }
  const put = async (file: string, content: string) => {
    await writeFile(file, content, 'utf8');
    cleanup.push(() => unlink(file));
  };
  const settingsPath = path.join(native, 'settings.json');
  const calls = path.join(homeDir, 'calls');
  await put(settingsPath, JSON.stringify({ model: 'fixture', hooks: { fixture: true }, ...settings }));
  await put(calls, '');
  const excluded = {
    AGY_DISABLE_SLASH_COMMANDS: '1',
    gemini_api_key: 'fixture-key',
    GOOGLE_API_KEY: 'fixture-key',
    GOOGLE_GEMINI_BASE_URL: 'fixture-endpoint',
    AGY_ADC_AUTH: 'true',
    GOOGLE_APPLICATION_CREDENTIALS: 'fixture-adc',
    GOOGLE_CLOUD_QUOTA_PROJECT: 'fixture-project',
  };
  const env = {
    PATH: homeDir,
    SystemRoot: process.env.SystemRoot,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ANTIGRAVITY_GEMINI_DIR: gemini,
    ...excluded,
  };
  // 只允许 PATH 中这份本地夹具；Windows 通过已有的 npm shim 解析走真实 runProcess。
  const script = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
const root = process.cwd();
const isolated = path.join(root, '.gemini');
if (root === ${JSON.stringify(homeDir)} || process.env.HOME !== root || process.env.USERPROFILE !== root ||
    process.env.ANTIGRAVITY_GEMINI_DIR !== isolated ||
    ${JSON.stringify(Object.keys(excluded))}.some((name) => Object.hasOwn(process.env, name))) process.exit(2);
const config = require(path.join(isolated, 'antigravity-cli', 'settings.json'));
if (Object.keys(config).some((key) => key !== 'enableTelemetry') || config.enableTelemetry !== false) process.exit(2);
if (args.join(' ') === '--version') console.log(${JSON.stringify(version)});
else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(usageArgs))}) {
  ${switchProvider ? `fs.writeFileSync(${JSON.stringify(settingsPath)}, '{"modelProvider":"gemini"}');` : ''}
  console.error(${JSON.stringify(privateDiagnostic)});
  console.log(${JSON.stringify(JSON.stringify(payload))});
  process.exitCode = ${exitCode};
} else process.exit(2);
`;
  if (process.platform === 'win32') {
    await put(path.join(homeDir, 'agy.cjs'), script);
    await put(path.join(homeDir, 'agy.cmd'), `@ECHO off\r\n"${process.execPath}" "%~dp0agy.cjs" %*\r\n`);
  } else {
    const executable = path.join(homeDir, 'agy');
    await put(executable, `#!${process.execPath}\n${script}`);
    await chmod(executable, 0o755);
  }
  const app = Fastify();
  cleanup.push(() => app.close());
  registerAntigravityUsageRoute(app, (signal) => readAntigravityOfficialUsage({ env, homeDir, signal }));
  return { app, post: () => app.inject({ method: 'POST', url }), calls: () => readFile(calls, 'utf8') };
}

it('只从隔离的原生 /usage 响应返回额度白名单，保留零、空组和未知字段的区别', async () => {
  const reset = '2026-11-20T12:00:00Z';
  const { app, post, calls } = await localCli({
    payload: {
      ...report([
        {
          name: '模型组',
          description: privateDiagnostic,
          buckets: [
            { id: 'daily', name: '短窗口', window: '5h', remaining_fraction: 0, reset_time: reset },
            { id: 'weekly', name: '长窗口', remaining_fraction: null, reset_time: '未报告' },
          ],
        },
        { name: '空组', buckets: [] },
      ]),
      usage: { input_tokens: 12 },
    },
  });
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  expect(await calls()).toBe('');
  const response = await post();
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({
    checkedAt: expect.any(Number),
    groups: [
      {
        name: '模型组',
        buckets: [
          { id: 'daily', name: '短窗口', window: '5h', remainingFraction: 0, resetAt: reset },
          { id: 'weekly', name: '长窗口' },
        ],
      },
      { name: '空组', buckets: [] },
    ],
  });
  expect(await calls()).toBe(`--version\n${usageArgs.join(' ')}\n`);
});

it.each(['gemini', 'future-provider', 12])('拒绝显式配置的非账号模式 %j，不启动 CLI', async (modelProvider) => {
  const { post, calls } = await localCli({ settings: { modelProvider } });
  expect((await post()).statusCode).toBe(409);
  expect(await calls()).toBe('');
});

it.each(['1.1.10', '1.1.11-rc.1'])('版本 %s 只执行版本探测，不能把 /usage 送成提示词', async (version) => {
  const { post, calls } = await localCli({ version });
  const response = await post();
  expect(response.statusCode).toBe(503);
  expect(response.json().message).toContain('1.1.11');
  expect(await calls()).toBe('--version\n');
});

it.each(['', '  '])('空原生连接值 %j 按账号模式查询，合法空列表不是读取失败', async (modelProvider) => {
  const { post } = await localCli({ version: '1.5.11', settings: { modelProvider } });
  const response = await post();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ checkedAt: expect.any(Number), groups: [] });
});

it('在途切换到 API Key 后丢弃本次额度', async () => {
  const { post, calls } = await localCli({ switchProvider: true });
  expect((await post()).statusCode).toBe(409);
  expect(await calls()).toBe(`--version\n${usageArgs.join(' ')}\n`);
});

it.each([
  ['命令不同', { payload: { status: 'SUCCESS', command: { name: 'model', data: { groups: [] } } } }],
  ['授权失败', { payload: { ...report([]), status: 'ERROR', error: privateDiagnostic } }],
  ['额度缺失', { payload: report(undefined) }],
  ['非零退出', { exitCode: 1 }],
] as const)('%s 不冒充空额度，也不返回原生诊断', async (_label, fixture) => {
  const { post } = await localCli(fixture);
  const response = await post();
  expect(response.statusCode).toBe(503);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain(privateDiagnostic);
  expect(response.json()).toEqual({ code: expect.any(String), message: expect.any(String) });
});

it('请求已进入路由后，客户端断开会取消读取', async () => {
  const app = Fastify();
  cleanup.push(() => app.close());
  let active: AbortSignal | undefined;
  registerAntigravityUsageRoute(app, (signal) => {
    active = signal;
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error(privateDiagnostic)), { once: true }),
    );
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = request(`${origin}${url}`, { method: 'POST' });
  client.on('error', () => undefined);
  client.end();
  try {
    await vi.waitFor(() => expect(active?.aborted).toBe(false));
    client.destroy();
    await vi.waitFor(() => expect(active?.aborted).toBe(true));
  } finally {
    client.destroy();
  }
});
