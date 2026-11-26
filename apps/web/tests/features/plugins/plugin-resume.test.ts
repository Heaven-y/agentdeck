import { beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '@agentdeck/shared/conversation';
import { useChat, startChatConnection } from '../../../src/features/chat/state/chat-store';
import { createPluginUiServices } from '../../../src/features/plugins/plugin-ui-services';
import { handlePluginRequest } from '../../../src/features/plugins/plugin-bridge';
import type { WorkbenchPluginManifest } from '@agentdeck/shared/plugins';

const sent: ClientMessage[] = [];
let emit: (message: ServerMessage) => void;
startChatConnection((handlers) => {
  emit = handlers.onMessage;
  return {
    send: (message) => {
      sent.push(message);
      return true;
    },
    reconnect() {},
    close() {},
  };
});
const first = '5484d0e4-1458-4d61-8b7c-2a52676dc25a';
const second = 'e24aa514-5977-4973-9508-4754e0e0a9fb';
let requestId = crypto.randomUUID();
const manifest: WorkbenchPluginManifest = {
  id: 'delegate',
  name: '委派',
  version: '1.0.0',
  apiVersion: 2,
  entry: 'index.html',
  permissions: ['session-context', 'session-control'],
  commands: [],
};
beforeEach(() => {
  requestId = crypto.randomUUID();
  sent.length = 0;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  useChat.setState(useChat.getInitialState(), true);
  const base = useChat.getState();
  useChat.setState({
    conversationId: first,
    sessionId: 'current',
    workspaceId: 'project',
    draft: '当前草稿',
    connection: 'open',
    tabIds: [first, second],
    background: {
      [second]: {
        ...base,
        conversationId: second,
        sessionId: 'target',
        workspaceId: 'project',
        agent: 'antigravity',
        draft: '目标草稿',
      },
    },
  });
});
it('插件只续接指定的已打开空闲会话，保留两边草稿并去重', async () => {
  const ui = createPluginUiServices();
  expect(ui.sessions()).toHaveLength(2);
  const input = {
    type: 'agentdeck.plugin.request',
    id: 'resume',
    method: 'session.resume',
    params: { conversationId: second, requestId, text: '继续验收' },
  };
  expect(await handlePluginRequest(manifest, input, { ui })).toEqual({ accepted: false });
  emit({
    type: 'turn.started',
    clientTurnId: requestId,
    turnId: 'server-turn',
    workspaceId: 'project',
    agent: 'antigravity',
  });
  expect(await handlePluginRequest(manifest, input, { ui })).toEqual({ accepted: true });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: 'chat.send',
    conversationId: second,
    sessionId: 'target',
    agent: 'antigravity',
    clientTurnId: requestId,
  });
  expect(useChat.getState()).toMatchObject({
    conversationId: first,
    draft: '当前草稿',
    background: { [second]: { draft: '目标草稿', running: true } },
  });
});
it('缺权限、已关闭标签及忙碌会话都不发送', async () => {
  const ui = createPluginUiServices();
  const input = {
    type: 'agentdeck.plugin.request',
    id: 'resume',
    method: 'session.resume',
    params: { conversationId: second, requestId, text: '继续验收' },
  };
  await expect(handlePluginRequest({ ...manifest, permissions: ['session-context'] }, input, { ui })).rejects.toThrow(
    '权限',
  );
  useChat.setState({ tabIds: [first] });
  expect(ui.resume(input.params)).toEqual({ accepted: false });
  useChat.setState({
    tabIds: [first, second],
    background: { [second]: { ...useChat.getState().background[second]!, running: true } },
  });
  expect(ui.resume(input.params)).toEqual({ accepted: false });
  expect(sent).toHaveLength(0);
});

it('标签快速关闭重开也更新打开标识，普通状态更新不改变标识', () => {
  const ui = createPluginUiServices();
  const opened = () => ui.sessions().find((session) => session.conversationId === second)?.openId;
  const original = opened();
  expect(original).toBeTypeOf('string');
  useChat.setState({ draft: '保留新草稿' });
  expect(opened()).toBe(original);
  useChat.setState({ tabIds: [first] });
  useChat.setState({ tabIds: [first, second] });
  expect(opened()).toBeTypeOf('string');
  expect(opened()).not.toBe(original);
});
