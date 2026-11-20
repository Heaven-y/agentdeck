// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { AgentEvent } from '@agentdeck/shared/conversation';
import {
  historyItems,
  reduceChat,
  type ChatItem,
} from '../../../../src/features/conversation/model/conversation-events';
import { MessageItem } from '../../../../src/features/conversation/timeline/MessageItem';
afterEach(cleanup);
it('响应模型随每条消息合并，型号变化单列，未知消息不补猜模型', () => {
  const items = historyItems([
    { type: 'text', delta: '一', responseModel: 'actual-one' },
    { type: 'text', delta: '二', responseModel: 'actual-one' },
    { type: 'text', delta: '三', responseModel: 'actual-two' },
    { type: 'turn_end', isError: false },
    { type: 'text', delta: '未知' },
  ] as AgentEvent[]);
  expect(items.filter((item) => item.kind === 'assistant')).toMatchObject([
    { text: '一二', responseModel: 'actual-one' },
    { text: '三', responseModel: 'actual-two' },
    { text: '未知' },
  ]);
  render(
    <>
      {items.map((item) => (
        <MessageItem key={item.id} item={item} />
      ))}
    </>,
  );
  expect(screen.getByText('响应模型：actual-one')).toBeTruthy();
  expect(screen.getByText('响应模型：actual-two')).toBeTruthy();
  expect(screen.getAllByText(/响应模型：/)).toHaveLength(2);
});

it('实时流的未知片段不继承下一条模型，用户与工具条目不重复显示模型', () => {
  let items: ChatItem[] = [];
  const events: AgentEvent[] = [
    { type: 'user_message', text: '示例输入' },
    { type: 'text', delta: '未提供模型的片段' },
    { type: 'text', delta: '已报告', responseModel: 'actual-stream-model' },
    { type: 'text', delta: '模型的片段', responseModel: 'actual-stream-model' },
    { type: 'tool_call', id: 'tool', name: 'Read', input: { path: 'example.ts' } },
  ];
  for (const event of events) items = reduceChat(items, event);
  expect(items.filter((item) => item.kind === 'assistant')).toMatchObject([
    { text: '未提供模型的片段', streaming: true },
    { text: '已报告模型的片段', responseModel: 'actual-stream-model', streaming: true },
  ]);
  render(
    <>
      {items.map((item) => (
        <MessageItem key={item.id} item={item} />
      ))}
    </>,
  );
  expect(screen.getAllByText(/响应模型：/)).toHaveLength(1);
  expect(screen.getByText('响应模型：actual-stream-model')).toBeTruthy();
});

it('相邻原生回复按步骤分别保留，不能因为响应模型相同就拼成一条', () => {
  const events = [
    { type: 'text', id: 'agy-step-1', delta: '第一段', responseModel: 'actual-model' },
    { type: 'text', id: 'agy-step-1', delta: '续文', responseModel: 'actual-model' },
    { type: 'text', id: 'agy-step-2', delta: '另一条', responseModel: 'actual-model' },
  ] as AgentEvent[];
  expect(historyItems(events)).toMatchObject([
    { kind: 'assistant', nativeId: 'agy-step-1', text: '第一段续文', responseModel: 'actual-model' },
    { kind: 'assistant', nativeId: 'agy-step-2', text: '另一条', responseModel: 'actual-model' },
  ]);
});
