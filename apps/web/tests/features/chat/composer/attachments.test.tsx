// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  nativeFeaturesFor,
  type ChatAttachment,
  type ClientMessage,
  type RecoveryNotice,
  type ServerMessage,
} from '@agentdeck/shared/conversation';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { attachmentApi } from '../../../../src/features/chat/composer/attachment-api';
import { useChat, startChatConnection } from '../../../../src/features/chat/state/chat-store';
import { ComposerAttachments } from '../../../../src/features/chat/composer/ComposerAttachments';
let owner = { token: 'owner', instanceId: 'instance' };
let connected = true;
let emit!: (message: ServerMessage) => void;
let recovery!: (notice: RecoveryNotice) => void;
const sent: ClientMessage[] = [];
beforeAll(() =>
  startChatConnection((handlers) => {
    emit = handlers.onMessage;
    recovery = handlers.onRecovery!;
    handlers.onStatus('open');
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      reconnect: () => {},
      close: () => {},
      identity: () => (connected ? owner : undefined),
    };
  }),
);
beforeEach(() => {
  owner = { token: 'owner', instanceId: 'instance' };
  connected = true;
  sent.length = 0;
  useChat.setState(useChat.getInitialState(), true);
  useChat.setState({ connection: 'open' });
  useChat.getState().selectWorkspace('project');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const asset: ChatAttachment = {
  id: '00000000-0000-4000-8000-000000000001',
  revision: 'a'.repeat(64),
  name: 'notes.txt',
  mimeType: 'text/plain',
  size: 1,
  kind: 'text',
};
const supported = () =>
  nativeFeaturesFor('claude', {
    runtime: 'claude-sdk',
    handshake: 'confirmed',
    cliVersion: '2.1.317',
    sdkVersion: '0.3.286',
    implemented: ['images', 'documents'],
  });
it('删除附件会取消正在上传的网络请求，失败后可重新选择并重试', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  let uploadSignal: AbortSignal | undefined;
  const upload = vi.spyOn(attachmentApi, 'upload').mockImplementation((_view, _owner, _file, signal?: AbortSignal) => {
    uploadSignal = signal;
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('已取消'))));
  });
  const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
  const pending = useChat.getState().addAttachments([file]);
  await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
  useChat.getState().removeAttachment(useChat.getState().draftAttachments[0]!.id);
  expect(uploadSignal?.aborted).toBe(true);
  await pending;
  expect(useChat.getState().draftAttachments).toEqual([]);
  expect(useChat.getState().attachmentsBusy).toBe(false);
  upload.mockRejectedValueOnce(new Error('网络故障'));
  await useChat.getState().addAttachments([file]);
  expect(useChat.getState().draftAttachments[0]).toMatchObject({ file, error: '网络故障' });
  upload.mockResolvedValue(asset);
  await useChat.getState().retryAttachments();
  expect(useChat.getState().draftAttachments[0]).toMatchObject({ asset, error: undefined });
});
it('检查能力时已移除的附件不会开始上传，忙碌时重复重试不重复请求', async () => {
  let ready!: (value: ReturnType<typeof supported>) => void;
  const features = vi.spyOn(attachmentApi, 'features').mockImplementation(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  const upload = vi.spyOn(attachmentApi, 'upload').mockResolvedValue(asset);
  const pending = useChat.getState().addAttachments([new File(['x'], 'notes.txt', { type: 'text/plain' })]);
  await useChat.getState().retryAttachments();
  expect(features).toHaveBeenCalledOnce();
  useChat.getState().removeAttachment(useChat.getState().draftAttachments[0]!.id);
  ready(supported());
  await pending;
  expect(upload).not.toHaveBeenCalled();
  expect(useChat.getState().attachmentsBusy).toBe(false);
});
it('不支持附件时保留文件与文字草稿，不上传也不发送', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(nativeFeaturesFor('claude'));
  const upload = vi.spyOn(attachmentApi, 'upload');
  useChat.getState().setDraft('既有文字');
  await useChat.getState().addAttachments([new File(['x'], 'notes.txt', { type: 'text/plain' })]);
  expect(upload).not.toHaveBeenCalled();
  expect(useChat.getState().draft).toBe('既有文字');
  expect(useChat.getState().draftAttachments[0]).toMatchObject({ name: 'notes.txt', error: expect.any(String) });
  expect(useChat.getState().send('既有文字')).toBe(false);
});
it('异步上传完成只更新创建它的会话，切换项目不接收旧附件', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(
    nativeFeaturesFor('claude', {
      runtime: 'claude-sdk',
      handshake: 'confirmed',
      cliVersion: '2.1.317',
      sdkVersion: '0.3.286',
      implemented: ['images', 'documents'],
    }),
  );
  let finish!: (value: ChatAttachment) => void;
  vi.spyOn(attachmentApi, 'upload').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const original = useChat.getState().conversationId;
  const pending = useChat.getState().addAttachments([new File(['x'], 'notes.txt', { type: 'text/plain' })]);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  useChat.getState().selectWorkspace('other');
  finish(asset);
  await pending;
  expect(useChat.getState().draftAttachments).toEqual([]);
  expect(useChat.getState().background[original]?.draftAttachments[0]?.asset).toEqual(asset);
});
it('批量附件遵守数量和字节预算，上传失败保持文字草稿，移除已上传资产会通知服务器', async () => {
  const features = vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  vi.spyOn(attachmentApi, 'upload').mockResolvedValue(asset);
  const remove = vi.spyOn(attachmentApi, 'remove').mockResolvedValue();
  const permission = { agent: 'claude' as const, mode: 'plan' as const };
  const { permissionDefaults } = useChat.getState();
  useChat.setState({ permissionDefaults: { ...permissionDefaults, values: { claude: permission } } });
  useChat.getState().setDraft('原草稿');
  for (const files of [
    Array.from({ length: 9 }, () => new File(['x'], 'a.txt')),
    Array.from({ length: 5 }, () => new File(['x'], 'a.png', { type: 'image/png' })),
    [new File([], 'empty')],
    [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large')],
    Array.from({ length: 5 }, () => new File([new Uint8Array(5 * 1024 * 1024)], 'a.txt')),
  ]) {
    await useChat.getState().addAttachments(files);
    expect(useChat.getState().draftAttachments).toEqual([]);
    expect(useChat.getState().draft).toBe('原草稿');
  }
  expect(features).not.toHaveBeenCalled();
  await useChat.getState().addAttachments([new File(['x'], 'notes.txt', { type: 'text/plain' })]);
  expect(features).toHaveBeenCalledWith(expect.objectContaining({ permission }), expect.anything(), false);
  const id = useChat.getState().draftAttachments[0]!.id;
  useChat.getState().attachmentPreviewFailed(id);
  expect(useChat.getState().draftAttachments[0]?.error).toContain('无法解码');
  useChat.getState().removeAttachment(id);
  expect(remove).toHaveBeenCalledWith(expect.anything(), expect.anything(), asset);
});
it('上传响应迟到不会恢复已删除行，受理失败的上一条输入可完整恢复', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  let finish!: (value: ChatAttachment) => void;
  vi.spyOn(attachmentApi, 'upload').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const remove = vi.spyOn(attachmentApi, 'remove').mockResolvedValue();
  const file = new File(['x'], 'notes.txt');
  const pending = useChat.getState().addAttachments([file]);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const draft = useChat.getState().draftAttachments[0]!;
  useChat.getState().removeAttachment(draft.id);
  finish(asset);
  await pending;
  expect(remove).toHaveBeenCalled();
  expect(useChat.getState().draftAttachments).toEqual([]);
  useChat.setState({ pendingAttachmentInput: { text: '上一条', attachments: [draft], rejected: true } });
  useChat.getState().restoreAttachmentInput();
  expect(useChat.getState().draft).toBe('上一条');
  expect(useChat.getState().draftAttachments).toEqual([draft]);
  expect(useChat.getState().pendingAttachmentInput).toBeUndefined();
});
it('结构校验通过的图片仍须浏览器解码成功，解码失败保留文件与文字并删除服务器草稿', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  const image = { ...asset, name: 'image.png', kind: 'image' as const, mimeType: 'image/png' };
  vi.spyOn(attachmentApi, 'upload').mockResolvedValue(image);
  vi.spyOn(attachmentApi, 'verifyImage').mockRejectedValue(new Error('图片无法解码'));
  const remove = vi.spyOn(attachmentApi, 'remove').mockResolvedValue();
  useChat.getState().setDraft('原草稿');
  await useChat.getState().addAttachments([new File(['broken'], 'image.png', { type: 'image/png' })]);
  expect(useChat.getState().draftAttachments[0]).toMatchObject({ error: '图片无法解码' });
  expect(useChat.getState().draftAttachments[0]?.asset).toBeUndefined();
  expect(useChat.getState().send('原草稿')).toBe(false);
  expect(useChat.getState().draft).toBe('原草稿');
  expect(remove).toHaveBeenCalledWith(expect.anything(), expect.anything(), image);
});

const failedBeforeStart = {
  error: () => emit({ type: 'error', message: '未受理', clientTurnId: useChat.getState().pendingClientTurnId }),
  ready: () => recovery({ type: 'connection.ready', sequence: 0, acceptedClientTurnIds: [] }),
  rejected: () => recovery({ type: 'connection.rejected', code: 'owner_missing', message: '身份已失效，请核对历史' }),
};
it.each(Object.entries(failedBeforeStart))('%s：轮次开始前失败恢复文字和File且不会重发', async (_name, fail) => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  vi.spyOn(attachmentApi, 'upload').mockResolvedValue(asset);
  const file = new File(['x'], 'notes.txt');
  useChat.getState().setDraft('原始输入');
  await useChat.getState().addAttachments([file]);
  expect(useChat.getState().send('原始输入')).toBe(true);
  expect(useChat.getState().draft).toBe('');
  fail();
  expect(useChat.getState().draft).toBe('原始输入');
  expect(useChat.getState().draftAttachments[0]?.file).toBe(file);
  expect(sent).toHaveLength(1);
});
it('已有新草稿时后台失败保留原输入，手动恢复入口不会覆盖新草稿且新发送不能丢备份', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  vi.spyOn(attachmentApi, 'upload').mockResolvedValue(asset);
  const file = new File(['x'], 'notes.txt');
  useChat.getState().setDraft('原始输入');
  await useChat.getState().addAttachments([file]);
  useChat.getState().send('原始输入');
  const original = useChat.getState().conversationId;
  const clientTurnId = useChat.getState().pendingClientTurnId;
  useChat.getState().setDraft('新草稿');
  useChat.getState().selectWorkspace('other');
  emit({ type: 'error', message: '未受理', clientTurnId });
  expect(useChat.getState().draft).toBe('');
  expect(useChat.getState().draftAttachments).toEqual([]);
  useChat.getState().openConversation(original);
  expect(useChat.getState().draft).toBe('新草稿');
  render(<ComposerAttachments />);
  expect(screen.getByRole('button', { name: '恢复上一条文字与附件' })).toBeTruthy();
  expect(useChat.getState().send('新草稿')).toBe(true);
  expect(useChat.getState().pendingAttachmentInput?.attachments[0]?.file).toBe(file);
  act(() => {
    emit({
      type: 'turn.started',
      clientTurnId: useChat.getState().pendingClientTurnId!,
      turnId: 'text',
      workspaceId: 'project',
      agent: 'claude',
    });
    emit({ type: 'turn.finished', turnId: 'text', workspaceId: 'project', agent: 'claude' });
    useChat.getState().setDraft('尚未发送的新草稿');
  });
  fireEvent.click(screen.getByRole('button', { name: '恢复上一条文字与附件' }));
  expect(useChat.getState().draft).toBe('原始输入');
  expect(useChat.getState().draftAttachments[0]?.file).toBe(file);
  expect(useChat.getState().pendingAttachmentInput?.text).toBe('尚未发送的新草稿');
  expect(useChat.getState().send('原始输入')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '放弃暂存输入' }));
  expect(useChat.getState().send('原始输入')).toBe(true);
});
it('owner更换后全部会话的草稿和待恢复输入清除旧引用，原File可显式重新上传', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  const upload = vi.spyOn(attachmentApi, 'upload').mockResolvedValue(asset);
  const file = new File(['x'], 'notes.txt');
  useChat.getState().setDraft('待恢复');
  await useChat.getState().addAttachments([file]);
  useChat.getState().send('待恢复');
  const original = useChat.getState().conversationId;
  useChat.getState().setDraft('原会话新草稿');
  useChat.getState().selectWorkspace('other');
  useChat.getState().setDraft('后台草稿');
  await useChat.getState().addAttachments([file]);
  owner = { token: 'new-owner', instanceId: 'instance' };
  recovery({ type: 'connection.ready', sequence: 0, acceptedClientTurnIds: [] });
  expect(useChat.getState().draft).toBe('后台草稿');
  expect(useChat.getState().draftAttachments[0]).toMatchObject({ file, error: expect.any(String) });
  expect(useChat.getState().draftAttachments[0]?.asset).toBeUndefined();
  const saved = useChat.getState().background[original]?.pendingAttachmentInput;
  expect(saved?.attachments[0]?.asset).toBeUndefined();
  expect(saved?.attachments[0]?.file).toBe(file);
  render(<ComposerAttachments />);
  fireEvent.click(screen.getByRole('button', { name: '重试附件' }));
  await vi.waitFor(() => expect(useChat.getState().draftAttachments[0]?.asset).toEqual(asset));
  expect(upload).toHaveBeenLastCalledWith(expect.anything(), owner, file, expect.any(AbortSignal));
  useChat.getState().openConversation(original);
  expect(useChat.getState().draft).toBe('原会话新草稿');
  useChat.getState().restoreAttachmentInput();
  expect(useChat.getState().draft).toBe('待恢复');
  expect(useChat.getState().draftAttachments[0]?.file).toBe(file);
  expect(useChat.getState().pendingAttachmentInput?.text).toBe('原会话新草稿');
  await useChat.getState().retryAttachments();
  expect(useChat.getState().draftAttachments[0]?.asset).toEqual(asset);
});
it('身份失效会取消旧上传，迟到响应不能污染新上传；相同owner的短暂重连复用引用', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  let finish!: (value: ChatAttachment) => void;
  let oldSignal: AbortSignal | undefined;
  const upload = vi
    .spyOn(attachmentApi, 'upload')
    .mockImplementationOnce((_view, _owner, _file, signal) => {
      oldSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValue({ ...asset, id: '00000000-0000-4000-8000-000000000002' });
  vi.spyOn(attachmentApi, 'remove').mockResolvedValue();
  const file = new File(['x'], 'notes.txt');
  useChat.getState().setDraft('文字');
  const pending = useChat.getState().addAttachments([file]);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  recovery({ type: 'connection.rejected', code: 'owner_missing', message: '后端已重启' });
  expect(oldSignal?.aborted).toBe(true);
  owner = { token: 'new-owner', instanceId: 'instance' };
  recovery({ type: 'connection.ready', sequence: 0, acceptedClientTurnIds: [] });
  await useChat.getState().retryAttachments();
  finish(asset);
  await pending;
  expect(useChat.getState().draftAttachments[0]?.asset?.id).toBe('00000000-0000-4000-8000-000000000002');
  expect(useChat.getState().draft).toBe('文字');
  connected = false;
  await useChat.getState().retryAttachments();
  expect(useChat.getState().draftAttachments[0]?.asset?.id).toBe('00000000-0000-4000-8000-000000000002');
  connected = true;
  recovery({ type: 'connection.ready', sequence: 0, acceptedClientTurnIds: [] });
  await useChat.getState().retryAttachments();
  expect(upload).toHaveBeenCalledTimes(2);
});
it('未知送达保留可见恢复入口并要求核对历史，恢复和上传重试都不会自动重发', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  vi.spyOn(attachmentApi, 'upload').mockResolvedValue(asset);
  const file = new File(['x'], 'notes.txt');
  useChat.getState().setDraft('状态未知的输入');
  await useChat.getState().addAttachments([file]);
  useChat.getState().send('状态未知的输入');
  useChat.getState().setDraft('新草稿');
  recovery({ type: 'connection.ready', sequence: 0, acceptedClientTurnIds: [] });
  render(<ComposerAttachments />);
  expect(screen.getByRole('status').textContent).toBe('这条消息可能已发出，请先重新读取会话。');
  fireEvent.click(screen.getByRole('button', { name: '恢复上一条文字与附件' }));
  expect(useChat.getState().draftAttachments[0]?.file).toBe(file);
  fireEvent.click(screen.getByRole('button', { name: '放弃暂存输入' }));
  await useChat.getState().retryAttachments();
  expect(useChat.getState().historyError).toBeTruthy();
  expect(useChat.getState().send('状态未知的输入')).toBe(false);
  expect(sent).toHaveLength(1);
});
it('早期拒绝A后纯文字B创建原生会话，恢复A必须按新scope显式重传并使用新引用发送', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  const nativeAsset = { ...asset, id: '00000000-0000-4000-8000-000000000002' };
  const upload = vi.spyOn(attachmentApi, 'upload').mockResolvedValueOnce(asset).mockResolvedValue(nativeAsset);
  const file = new File(['x'], 'notes.txt');
  useChat.getState().setDraft('A');
  await useChat.getState().addAttachments([file]);
  expect(useChat.getState().send('A')).toBe(true);
  const clientTurnIdA = useChat.getState().pendingClientTurnId;
  useChat.getState().setDraft('B');
  emit({ type: 'error', clientTurnId: clientTurnIdA, message: '未受理' });
  expect(useChat.getState().send('B')).toBe(true);
  emit({
    type: 'turn.started',
    clientTurnId: useChat.getState().pendingClientTurnId!,
    turnId: 'text-b',
    workspaceId: 'project',
    agent: 'claude',
  });
  emit({
    type: 'agent.event',
    turnId: 'text-b',
    event: { type: 'session', sessionId: 'native-from-text', cwd: '~/projects/demo', model: 'fixture' },
  });
  emit({ type: 'turn.finished', turnId: 'text-b', workspaceId: 'project', agent: 'claude' });
  expect(useChat.getState().pendingAttachmentInput?.attachments[0]?.file).toBe(file);
  useChat.getState().restoreAttachmentInput();
  expect(useChat.getState().draft).toBe('A');
  expect(useChat.getState().draftAttachments[0]?.file).toBe(file);
  expect(useChat.getState().draftAttachments[0]?.asset).toBeUndefined();
  expect(useChat.getState().send('A')).toBe(false);
  render(<ComposerAttachments />);
  fireEvent.click(screen.getByRole('button', { name: '重试附件' }));
  await vi.waitFor(() => expect(useChat.getState().draftAttachments[0]?.asset).toEqual(nativeAsset));
  expect(upload).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: 'native-from-text' }),
    owner,
    file,
    expect.any(AbortSignal),
  );
  recovery({ type: 'connection.ready', sequence: 0, acceptedClientTurnIds: [] });
  await useChat.getState().retryAttachments();
  expect(upload).toHaveBeenCalledTimes(2);
  expect(sent).toHaveLength(2);
  expect(useChat.getState().send('A')).toBe(true);
  expect(sent.at(-1)).toMatchObject({
    type: 'chat.send',
    text: 'A',
    sessionId: 'native-from-text',
    attachments: [{ id: nativeAsset.id, revision: nativeAsset.revision }],
  });
});
it('上传期间取得原生session时迟到响应保持原scope，保留File供新scope重传', async () => {
  vi.spyOn(attachmentApi, 'features').mockResolvedValue(supported());
  let finish!: (value: ChatAttachment) => void;
  const nativeAsset = { ...asset, id: '00000000-0000-4000-8000-000000000002' };
  const upload = vi
    .spyOn(attachmentApi, 'upload')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(nativeAsset);
  useChat.getState().send('B');
  emit({
    type: 'turn.started',
    clientTurnId: useChat.getState().pendingClientTurnId!,
    turnId: 'text-b',
    workspaceId: 'project',
    agent: 'claude',
  });
  const file = new File(['x'], 'notes.txt');
  useChat.getState().setDraft('跟随文字');
  const pending = useChat.getState().addAttachments([file]);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  emit({
    type: 'agent.event',
    turnId: 'text-b',
    event: { type: 'session', sessionId: 'native-during-upload', cwd: '~/projects/demo', model: 'fixture' },
  });
  emit({ type: 'turn.finished', turnId: 'text-b', workspaceId: 'project', agent: 'claude' });
  finish(asset);
  await pending;
  expect(upload.mock.calls[0]![0].sessionId).toBeUndefined();
  expect(useChat.getState().draftAttachments[0]?.file).toBe(file);
  expect(useChat.getState().draftAttachments[0]?.asset).toBeUndefined();
  expect(useChat.getState().draft).toBe('跟随文字');
  expect(useChat.getState().send('跟随文字')).toBe(false);
  await useChat.getState().retryAttachments();
  expect(upload).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: 'native-during-upload' }),
    owner,
    file,
    expect.any(AbortSignal),
  );
  expect(useChat.getState().draftAttachments[0]?.asset).toEqual(nativeAsset);
  expect(sent).toHaveLength(1);
});
