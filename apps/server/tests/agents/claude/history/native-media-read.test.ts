import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeSessions } from '../../../../src/agents/claude/history/sessions';
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk';
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(),
}));
it('目录定位因原生路径别名缺失时，仅在全局记录cwd等价后读取媒体，其他项目仍拒绝', async () => {
  const dir = path.join(tmpdir(), 'native-alias-fixture');
  const info = { sessionId: 'session', summary: 'fixture', cwd: dir, lastModified: 1, fileSize: 100 };
  vi.mocked(getSessionInfo).mockImplementation(async (_id, options) => (options?.dir ? undefined : info));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
  vi.mocked(getSessionMessages).mockImplementation(async (_id, options) =>
    options?.dir
      ? []
      : [
          {
            type: 'user',
            uuid: 'message',
            session_id: 'session',
            message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] },
          } as never,
        ],
  );
  const provider = createClaudeSessions();
  const locator = { sessionId: 'session', messageId: 'message', kind: 'user' as const, index: 0 };
  expect((await provider.media!('session', dir, locator)).data.toString('base64')).toBe(png);
  vi.mocked(getSessionMessages).mockClear();
  await expect(provider.media!('session', path.join(dir, 'other-project'), locator)).rejects.toThrow('当前工作区');
  expect(getSessionMessages).not.toHaveBeenCalled();
});
