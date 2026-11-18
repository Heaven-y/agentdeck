import { expect, it, vi } from 'vitest';
import { claudeInput, codexAttachments, acpInput, markEmbedded } from '../../src/agents/common/media/attachment-input';
import { imageSource, claudeMediaBlock } from '../../src/agents/common/media/native-media';
import { ClaudeEventMapper } from '../../src/agents/claude/run/mapper';
import { CodexEventMapper } from '../../src/agents/codex/run/mapper';
import { antigravityHistory } from '../../src/agents/antigravity/history/history';
import type { NativeAttachment } from '../../src/agents/contracts';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexToolImage, codexToolMedia, mcpResultText } from '../../src/agents/codex/media/media';
import { createClaudeSubagentMedia, createClaudeSubagents } from '../../src/agents/claude/history/subagents';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=',
  'base64',
);
const image: NativeAttachment = {
  id: '00000000-0000-4000-8000-000000000001',
  revision: 'a'.repeat(64),
  name: 'fixture.png',
  mimeType: 'image/png',
  kind: 'image',
  size: png.length,
  data: png,
  path: path.join(tmpdir(), 'fixture.png'),
};
it('三CLI图片分别采用原生内容块，文件引用不冒充图片或已解析文档', () => {
  expect(claudeInput('', [image])).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
  ]);
  expect(codexAttachments([image])).toEqual([
    { type: 'image', url: `data:image/png;base64,${png.toString('base64')}` },
  ]);
  expect(acpInput('', [image])).toEqual([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
  const text = {
    ...image,
    kind: 'text' as const,
    name: 'notes.txt',
    mimeType: 'text/plain',
    data: Buffer.from('示例文本'),
  };
  expect(claudeInput('问题', [text])).toMatchObject([
    { type: 'text', text: '问题' },
    { type: 'document', source: { type: 'text', data: '示例文本' } },
  ]);
  expect(codexAttachments([text])).toMatchObject([{ type: 'text', text: expect.stringContaining('notes.txt') }]);
  expect(acpInput('', [text])).toMatchObject([{ type: 'resource', resource: { text: '示例文本' } }]);
  expect(claudeInput('', [{ ...text, kind: 'pdf', data: Buffer.from('%PDF-') }])).toMatchObject([
    { type: 'document', source: { media_type: 'application/pdf' } },
  ]);
  expect(acpInput('', [{ ...text, kind: 'file' }])).toMatchObject([
    { type: 'text', text: expect.stringContaining('本机文件引用') },
  ]);
});
it('Claude工具图片可从消息定位读取，已确认内联图片的缓存失败不改变成功回复', async () => {
  const block = {
    type: 'tool_result',
    tool_use_id: 'tool',
    content: [
      { type: 'text', text: '结果' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
    ],
  };
  const message = { type: 'user', uuid: 'result', message: { content: [block] } };
  const events = new ClaudeEventMapper('session').mapHistory(message);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool_result',
      attachments: [
        expect.objectContaining({ locator: { sessionId: 'session', messageId: 'tool', kind: 'tool', index: 1 } }),
      ],
    }),
  );
  expect(
    (
      await imageSource(
        claudeMediaBlock([message], { sessionId: 'session', messageId: 'tool', kind: 'tool', index: 1 }),
      )
    ).data,
  ).toEqual(png);
  const stored = vi.fn().mockRejectedValue(new Error('缓存磁盘不可写'));
  const input = {
    workspace: { id: 'w', name: 'fixture', dir: process.cwd() },
    text: '',
    attachments: [image],
    attachmentsStored: stored,
    emit: () => {},
    requestPermission: async () => ({ allow: false }),
  };
  await expect(markEmbedded(input, ['image'])).resolves.toBeUndefined();
  expect(stored).toHaveBeenCalledWith([image.id]);
  await markEmbedded(input, ['text']);
  expect(stored).toHaveBeenCalledOnce();
  expect(claudeInput('文字')).toBe('文字');
  expect(claudeInput('', [{ ...image, kind: 'file' }])).toMatchObject([{ type: 'text' }]);
  expect(acpInput('文字')).toMatchObject([{ type: 'text', text: '文字' }]);
});
it('旧原生本机图片按已保存文件引用读取，删除后明确失败，拒绝伪MIME与相对路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentdeck-native-image-'));
  const file = path.join(root, 'image.png');
  try {
    await writeFile(file, png);
    expect((await imageSource({ path: file })).data).toEqual(png);
    expect((await imageSource({ uri: pathToFileURL(file).href })).data).toEqual(png);
    expect((await imageSource({ inlineData: png.toString('base64'), mimeType: 'image/png' })).data).toEqual(png);
    await expect(imageSource({ inlineData: png.toString('base64'), mimeType: 'image/jpeg' })).rejects.toThrow();
    await expect(imageSource({ path: 'relative.png' })).rejects.toThrow();
    await rm(file);
    await expect(imageSource({ path: file })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('Codex工具图片保留原始索引，正文剔除图片字节，非图片和跨索引读取拒绝', async () => {
  const mcp = {
    type: 'mcpToolCall',
    id: 'tool',
    result: {
      content: [
        { type: 'text', text: '工具说明' },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ],
    },
  };
  const dynamic = {
    type: 'dynamicToolCall',
    id: 'dynamic',
    contentItems: [{ type: 'inputImage', imageUrl: `data:image/png;base64,${png.toString('base64')}` }],
  };
  expect(codexToolMedia(mcp, 'session').attachments?.[0]).toMatchObject({ locator: { messageId: 'tool', index: 1 } });
  expect(mcpResultText(mcp)).toContain('工具说明');
  expect(mcpResultText(mcp)).not.toContain(png.toString('base64'));
  expect((await codexToolImage(mcp, 1)).data).toEqual(png);
  expect((await codexToolImage(dynamic, 0)).data).toEqual(png);
  expect(() => codexToolImage(mcp, 0)).toThrow();
  expect(() => codexToolImage({ type: 'unknown' }, 0)).toThrow();
  expect(codexToolMedia(mcp)).toEqual({});
  expect(codexToolMedia({ type: 'unknown' }, 'session')).toEqual({});
  expect(codexToolMedia(dynamic, 'session').attachments).toHaveLength(1);
  expect(codexToolMedia({ type: 'imageView', id: 'view' }, 'session').attachments).toHaveLength(1);
  expect(
    (await codexToolImage({ type: 'imageView', url: `data:image/png;base64,${png.toString('base64')}` }, 0)).data,
  ).toEqual(png);
  expect(mcpResultText({ error: '失败' })).toBe('失败');
  expect(mcpResultText({ error: { code: 'failed' } })).toContain('failed');
  expect(mcpResultText({ result: '完成' })).toContain('完成');
});
it('Claude子代理图片只沿已验证父子关系读取，定位随独立子代理历史返回', async () => {
  const message = {
    type: 'user',
    uuid: 'child-message',
    message: {
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }],
    },
  };
  const api = { list: vi.fn(async () => ['child']), messages: vi.fn(async () => [message]) };
  const read = createClaudeSubagentMedia(api);
  const locator = {
    sessionId: 'parent',
    subagentId: 'child',
    messageId: 'child-message',
    kind: 'user' as const,
    index: 0,
  };
  expect((await read('parent', process.cwd(), locator)).data).toEqual(png);
  const history = await createClaudeSubagents(api)('parent', process.cwd(), { agentId: 'child' });
  expect('events' in history ? history.events : undefined).toContainEqual(
    expect.objectContaining({ attachments: [expect.objectContaining({ locator })] }),
  );
  api.messages.mockClear();
  await expect(read('parent', process.cwd(), { ...locator, subagentId: 'foreign' })).rejects.toThrow();
  expect(api.messages).not.toHaveBeenCalled();
  await expect(read('parent', process.cwd(), { ...locator, messageId: 'foreign' })).rejects.toThrow();
});
it('原生图片定位只保留消息身份，正文与工具输出不夹带base64', () => {
  const claude = {
    type: 'user',
    uuid: 'user-message',
    session_id: 'session',
    message: {
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }],
    },
  };
  const events = new ClaudeEventMapper('session').mapHistory(claude);
  expect(events).toMatchObject([
    {
      type: 'user_message',
      text: '',
      attachments: [{ locator: { sessionId: 'session', messageId: 'user-message', index: 0, kind: 'user' } }],
    },
  ]);
  expect(JSON.stringify(events)).not.toContain(png.toString('base64'));
  const codex = new CodexEventMapper({ sessionId: 'session' }).history({
    id: 'turn',
    status: 'completed',
    items: [
      {
        type: 'userMessage',
        id: 'message',
        content: [{ type: 'image', url: `data:image/png;base64,${png.toString('base64')}` }],
      },
    ],
  });
  expect(codex[0]).toMatchObject({
    type: 'user_message',
    attachments: [{ locator: { messageId: 'message', index: 0 } }],
  });
  const agy = antigravityHistory({
    cascadeId: 'session',
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        userInput: { media: [{ mimeType: 'image/png', inlineData: png.toString('base64') }] },
      },
    ],
  });
  expect(agy[0]).toMatchObject({ type: 'user_message', attachments: [{ locator: { messageId: '0', index: 0 } }] });
  expect(() =>
    claudeMediaBlock([claude], { sessionId: 'session', messageId: 'foreign', index: 0, kind: 'user' }),
  ).toThrow();
});
it('媒体读取拒绝远程URL和损坏字节，已验证内联图可返回原始内容', async () => {
  await expect(imageSource({ type: 'image', url: 'https://example.test/private.png' })).rejects.toThrow();
  await expect(
    imageSource({ source: { type: 'base64', media_type: 'image/png', data: 'not-base64' } }),
  ).rejects.toThrow();
  expect((await imageSource({ url: `data:image/png;base64,${png.toString('base64')}` })).data).toEqual(png);
});
