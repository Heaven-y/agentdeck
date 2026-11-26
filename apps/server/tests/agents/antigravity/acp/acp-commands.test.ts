import { expect, it, vi } from 'vitest';
import { AcpCommands, acpCommandEntries, discoverAcpCommands } from '../../../../src/agents/antigravity/acp/commands';
import { AntigravityAcpClient } from '../../../../src/agents/antigravity/acp/client';
import type { AcpConnection } from '../../../../src/agents/antigravity/acp/types';
it('ACP命令来自当前会话实时目录，拒绝未知命令、外会话和撤销后的旧目录', () => {
  const commands = new AcpCommands();
  commands.update({
    sessionId: 'native',
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'compact', description: '压缩' },
        { name: 'plan', description: '计划' },
      ],
    },
  });
  expect(commands.input('native', 'plan', '目标')).toBe('/plan 目标');
  expect(commands.input('native', 'compact', '')).toBe('/compact');
  expect(() => commands.input('other', 'compact', '')).toThrow();
  expect(() => commands.input('native', 'unknown', '')).toThrow();
  commands.update({
    sessionId: 'native',
    update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
  });
  expect(() => commands.input('native', 'compact', '')).toThrow();
});

it('目录发现不发送prompt，等待异步目录完成并关闭客户端，原生不兼容只停用专用命令', async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'session/new') {
      setTimeout(
        () =>
          client.onNotification('session/update', {
            sessionId: 'native',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'plan' }] },
          }),
        0,
      );
      return { sessionId: 'native' };
    }
    return {};
  });
  const close = vi.fn(async () => {});
  const client = { request, close, onNotification() {} } as unknown as AcpConnection;
  const start = vi.spyOn(AntigravityAcpClient, 'start').mockResolvedValue(client);
  try {
    expect(
      (await discoverAcpCommands({ root: process.cwd(), gemini: process.cwd(), env: {} })).map((entry) => entry.name),
    ).toEqual(['plan']);
    // 探测结束必须关掉自己建的原生会话，否则它会作为空会话留在原生列表里。
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'authenticate',
      'session/new',
      'session/close',
    ]);
    expect(close).toHaveBeenCalledOnce();
    request.mockRejectedValueOnce(new Error('unsupported'));
    expect(await discoverAcpCommands({ root: process.cwd(), gemini: process.cwd(), env: {} })).toEqual([]);
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    start.mockRestore();
  }
});

it('原生会话已建立时即使目录等待失败也要关掉它', async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'session/new') return { sessionId: 'native' };
    return {};
  });
  const close = vi.fn(async () => {});
  const client = { request, close, onNotification() {} } as unknown as AcpConnection;
  const start = vi.spyOn(AntigravityAcpClient, 'start').mockResolvedValue(client);
  try {
    const pending = discoverAcpCommands({ root: process.cwd(), gemini: process.cwd(), env: {} });
    // 目录通知始终不来：ready 会超时，但会话仍然必须被关闭。
    await expect(pending).resolves.toEqual([]);
    expect(request.mock.calls.map(([method]) => method)).toContain('session/close');
  } finally {
    start.mockRestore();
  }
});
it('目录缺失等待有界，取消立即关闭等待且不能借外会话目录发送', async () => {
  vi.useFakeTimers();
  try {
    const commands = new AcpCommands();
    const failed = expect(commands.ready('missing')).rejects.toThrow('列表尚未就绪');
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    const controller = new AbortController();
    const cancelled = expect(commands.ready('native', controller.signal)).rejects.toThrow('取消');
    controller.abort();
    await cancelled;
    commands.update({
      sessionId: 'native',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] },
    });
    await commands.ready('native');
    expect(commands.input('native', 'compact', '继续整理')).toBe('/compact 继续整理');
  } finally {
    vi.useRealTimers();
  }
});
it('只开放已经核验语义的ACP命令，定时调度明确保留原生入口，不覆盖技能目录', () => {
  const entries = acpCommandEntries([
    { name: 'compact' },
    { name: 'plan' },
    { name: 'schedule' },
    { name: 'custom-skill' },
    { name: '../unsafe' },
  ]);
  expect(entries.map((entry) => entry.name)).toEqual(['compact', 'plan', 'schedule']);
  expect(entries[0]).toMatchObject({
    available: true,
    requiresSession: true,
    invocation: { kind: 'acp-command', name: 'compact' },
  });
  expect(entries[2]).toMatchObject({ available: false });
});
