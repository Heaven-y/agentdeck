// @vitest-environment jsdom
import { beforeAll, beforeEach, expect, it, vi, afterEach } from 'vitest';
import { attachmentApi } from '../../../src/features/chat/attachment-api';
import { steerAvailable } from '../../../src/features/chat/followup-state';
import type {
  ClientMessage,
  FollowupSnapshot,
  RecoveryNotice,
  ServerMessage,
  ChatAttachment,
} from '@agentdeck/shared/conversation';
import { startChatConnection, useChat } from '../../../src/features/chat/chat-store';
const queueId = '00000000-0000-4000-8000-000000000001';
const asset: ChatAttachment = {
  id: '00000000-0000-4000-8000-000000000002',
  revision: 'a'.repeat(64),
  name: 'notes.txt',
  kind: 'text',
  mimeType: 'text/plain',
  size: 1,
};
const sent: ClientMessage[] = [];
let emit!: (message: ServerMessage) => void, recovery!: (notice: RecoveryNotice) => void;
beforeAll(() =>
  startChatConnection((handlers) => {
    emit = handlers.onMessage;
    recovery = handlers.onRecovery!;
    return {
      send: (message) => {
        sent.push(message);
        return true;
      },
      identity: () => ({ token: 'owner', instanceId: 'instance' }),
      close() {},
      reconnect() {},
    };
  }),
);
beforeEach(() => {
  sent.length = 0;
  useChat.setState(useChat.getInitialState(), true);
  useChat.getState().selectWorkspace('project');
  useChat.setState({ connection: 'open' });
});
afterEach(() => vi.restoreAllMocks());
function queuedFile() {
  const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
  useChat.getState().send('创建会话');
  const first = sent[0] as Extract<ClientMessage, { type: 'chat.send' }>;
  emit({
    type: 'turn.started',
    turnId: 'turn',
    clientTurnId: first.clientTurnId,
    workspaceId: 'project',
    agent: 'claude',
    queueId,
  });
  const context: FollowupSnapshot = {
    queueId,
    workspaceId: 'project',
    agent: 'claude',
    conversationId: first.conversationId!,
    revision: 1,
    paused: false,
    items: [],
  };
  emit({ type: 'followup.state', snapshot: context });
  useChat.setState({
    draft: '排队附件',
    draftAttachments: [
      {
        id: 'file',
        file,
        name: file.name,
        asset,
        assetOwner: { token: 'owner', instanceId: 'instance' },
        assetScope: { workspaceId: 'project', agent: 'claude', conversationId: first.conversationId! },
      },
    ],
  });
  expect(useChat.getState().send('排队附件')).toBe(true);
  const queued = sent.at(-1) as Extract<ClientMessage, { type: 'chat.followup' }>;
  const state: FollowupSnapshot = {
    ...context,
    revision: 2,
    items: [
      {
        clientMessageId: queued.clientMessageId,
        mode: 'queue',
        revision: 0,
        status: 'queued',
        text: queued.content.text,
        content: queued.content,
      },
    ],
  };
  emit({ type: 'followup.state', snapshot: state });
  return { file, first, queued, state };
}
it('首次session可信绑定队列附件scope，自动轮次保留原File直到结果并不覆盖旧备份', () => {
  const { file, first, queued, state } = queuedFile();
  expect(useChat.getState().draftAttachments).toEqual([]);
  emit({ type: 'followup.state', snapshot: { ...state, revision: 3, sessionId: 'native-session' } });
  expect(
    useChat.getState().followups[queueId]!.drafts[queued.clientMessageId]!.attachments[0]!.assetScope?.sessionId,
  ).toBe('native-session');
  const oldFile = new File(['old'], 'old.txt');
  useChat.setState({
    pendingAttachmentInput: {
      text: 'P04旧备份',
      attachments: [{ id: 'old', name: 'old.txt', file: oldFile }],
      rejected: true,
    },
  });
  const input: Extract<ClientMessage, { type: 'chat.send' }> = {
    ...first,
    clientTurnId: 'fresh-attempt',
    text: '排队附件',
    sessionId: 'native-session',
    attachments: [{ id: asset.id, revision: asset.revision }],
  };
  emit({
    type: 'turn.started',
    workspaceId: 'project',
    agent: 'claude',
    turnId: 'next',
    clientTurnId: input.clientTurnId,
    queueId,
    followupClientMessageId: queued.clientMessageId,
    input,
  });
  expect(useChat.getState().pendingAttachmentInput?.attachments[0]?.file).toBe(file);
  expect(useChat.getState().draftBackups.some((backup) => backup.text === 'P04旧备份')).toBe(true);
  emit({
    type: 'followup.state',
    snapshot: {
      ...state,
      revision: 4,
      sessionId: 'native-session',
      items: state.items.map((item) => ({ ...item, status: 'accepted' })),
    },
  });
  expect(useChat.getState().followups[queueId]!.drafts[queued.clientMessageId]).toBeUndefined();
  expect(useChat.getState().pendingAttachmentInput?.attachments[0]?.file).toBe(file);
});
it('后端重启保留队列File为失效备份，恢复时保存当前草稿和P04备份且不自动发送', () => {
  const { file, queued } = queuedFile();
  useChat.setState({ draft: '新的草稿', pendingAttachmentInput: { text: '旧暂存', attachments: [], rejected: true } });
  recovery({ type: 'connection.rejected', code: 'owner_missing', message: '后端重启' });
  const count = sent.length;
  useChat.getState().restoreFollowup(queueId, queued.clientMessageId);
  expect(useChat.getState().draft).toBe('排队附件');
  expect(useChat.getState().draftAttachments[0]).toMatchObject({ file, asset: undefined, error: expect.any(String) });
  expect(useChat.getState().pendingAttachmentInput?.text).toBe('旧暂存');
  expect(useChat.getState().draftBackups.some((item) => item.text === '新的草稿')).toBe(true);
  expect(sent).toHaveLength(count);
});
it('页面256MiB预算包含队列File，同一File多处备份只计一次', async () => {
  const { file, queued } = queuedFile();
  const queue = useChat.getState().followups[queueId]!;
  const stored = queue.drafts[queued.clientMessageId]!;
  const files = Array.from({ length: 51 }, (_, index) => {
    const item = new File(['x'], `${index}.txt`);
    Object.defineProperty(item, 'size', { value: 5 * 1024 * 1024 });
    return { id: String(index), name: item.name, file: item };
  });
  useChat.setState({
    followups: {
      [queueId]: { ...queue, drafts: { [queued.clientMessageId]: { ...stored, attachments: [...files, ...files] } } },
    },
  });
  const next = new File(['xx'], 'over.txt');
  Object.defineProperty(next, 'size', { value: 2 * 1024 * 1024 });
  await useChat.getState().addAttachments([next]);
  expect(useChat.getState().banner).toContain('页面容量上限');
  const features = vi.spyOn(attachmentApi, 'features').mockRejectedValue(new Error('合成能力失败'));
  useChat.setState({
    followups: { [queueId]: { ...queue, drafts: { [queued.clientMessageId]: { ...stored, attachments: files } } } },
  });
  const small = new File(['x'], 'small.txt');
  await useChat.getState().addAttachments([small]);
  expect(features).toHaveBeenCalledOnce();
  expect(file).toBeInstanceOf(File);
});
it('运行中附件尚在上传时引导能力读取不访问未就绪asset', () => {
  queuedFile();
  const queue = useChat.getState().followups[queueId]!;
  useChat.setState({
    followups: { [queueId]: { ...queue, snapshot: { ...queue.snapshot, canSteer: true } } },
    draftAttachments: [{ id: 'uploading', name: 'uploading.txt', file: new File(['x'], 'uploading.txt') }],
    attachmentsBusy: true,
  });
  expect(() => steerAvailable(useChat.getState())).not.toThrow();
});
