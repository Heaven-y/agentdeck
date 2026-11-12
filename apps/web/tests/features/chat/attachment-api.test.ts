// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { nativeFeaturesFor } from '@agentdeck/shared/conversation';
import { attachmentApi } from '../../../src/features/chat/attachment-api';
const emptyConversationView = () => ({
  agent: 'claude' as const,
  conversationId: 'draft',
  workspaceId: undefined as string | undefined,
  modelOverrides: { claude: '', codex: '', antigravity: '' },
});
afterEach(() => vi.unstubAllGlobals());
it('图片解码成功或失败都回收临时URL，失败不返回可发送状态', async () => {
  const decode = vi.fn().mockResolvedValue(undefined),
    revoke = vi.fn();
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      decode = decode;
    },
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return 'blob:fixture';
      }
      static revokeObjectURL = revoke;
    },
  );
  const file = new File(['x'], 'image.png');
  await attachmentApi.verifyImage(file);
  decode.mockRejectedValueOnce(new Error('无法解码'));
  await expect(attachmentApi.verifyImage(file)).rejects.toThrow('图片无法解码');
  expect(revoke).toHaveBeenCalledTimes(2);
});
it('二进制上传与预览使用身份header和取消signal，URL只保留会话定位和版本', async () => {
  const view = {
    ...emptyConversationView(),
    workspaceId: 'project',
    sessionId: 'native',
    permission: { agent: 'claude' as const, mode: 'default' as const },
    modelOverrides: { claude: 'fixture', codex: '', antigravity: '' },
  };
  const identity = { token: 'private-token', instanceId: 'private-instance' };
  const asset = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 'a'.repeat(64),
    name: 'notes.txt',
    mimeType: 'text/plain',
    kind: 'text',
    size: 1,
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(nativeFeaturesFor('claude')))
    .mockResolvedValueOnce(Response.json(asset))
    .mockResolvedValueOnce(new Response('x'))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response('native'));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
  await attachmentApi.features(view, identity);
  expect(await attachmentApi.upload(view, identity, file, signal)).toEqual(asset);
  await attachmentApi.preview(view, identity, asset, signal);
  await attachmentApi.remove(view, identity, asset);
  await attachmentApi.nativeMedia(
    view,
    { sessionId: 'native', subagentId: 'child', messageId: 'm', index: 0, kind: 'tool' },
    signal,
  );
  const upload = fetcher.mock.calls[1]!;
  expect(upload[1]).toMatchObject({
    method: 'POST',
    body: file,
    signal,
    headers: { 'x-agentdeck-owner': identity.token },
  });
  expect(fetcher.mock.calls[0]![0]).toContain('model=fixture');
  expect(fetcher.mock.calls[2]![0]).toContain(`revision=${asset.revision}`);
  expect(fetcher.mock.calls[4]![0]).toContain('subagentId=child');
  for (const [url] of fetcher.mock.calls) expect(url).not.toContain('private-');
});
it('服务端错误保留可行动原因，原生媒体失败不会下载替代地址', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ message: '附件过大', code: 'attachment_invalid' }, { status: 400 }))
    .mockResolvedValueOnce(new Response('bad gateway', { status: 503 }))
    .mockResolvedValueOnce(new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const view = emptyConversationView();
  const identity = { token: 't', instanceId: 'i' };
  await expect(attachmentApi.upload(view, identity, new File(['x'], 'x'))).rejects.toThrow('附件过大');
  await expect(attachmentApi.features(view, identity)).rejects.toThrow('附件操作失败');
  await expect(
    attachmentApi.nativeMedia(view, { sessionId: 'native', messageId: 'm', index: 0, kind: 'user' }),
  ).rejects.toThrow('不可读取');
});
