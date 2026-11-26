// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { AgentEvent } from '@agentdeck/shared/conversation';
import { AgentBadge } from '../../../../src/features/sessions/list/AgentBadge';
import { SessionHeader } from '../../../../src/features/sessions/history/SessionHeader';
import { SessionTimeline } from '../../../../src/features/sessions/history/SessionTimeline';
import { useChat } from '../../../../src/features/chat/state/chat-store';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useChat.setState(useChat.getInitialState(), true);
});

const userEvent: AgentEvent = { type: 'user_message', text: '检查这个脚本' };
const assistantEvent: AgentEvent = { type: 'text', delta: '已检查' };

it('渲染用户与助手消息', () => {
  render(<SessionTimeline events={[userEvent, assistantEvent]} />);
  expect(screen.getByText('检查这个脚本')).toBeTruthy();
  expect(screen.getByText('已检查')).toBeTruthy();
});

it('关闭只读历史的错误只影响该处展示，不误删主会话同编号错误', () => {
  const items = [{ kind: 'error' as const, id: 'error-0', message: '主会话错误' }];
  useChat.setState({ items });
  const view = render(<SessionTimeline events={[{ type: 'error', message: '只读历史错误' }]} />);

  fireEvent.click(screen.getByRole('button', { name: '关闭这条错误' }));

  expect(screen.queryByText('只读历史错误')).toBeNull();
  expect(useChat.getState().items).toEqual(items);
  view.rerender(<SessionTimeline events={[{ type: 'error', message: '只读历史中的新错误' }]} />);
  expect(screen.getByText('只读历史中的新错误')).toBeTruthy();
});

it('把连续文本增量合并成一条助手消息，并让流式状态落定', () => {
  render(
    <SessionTimeline
      events={[
        userEvent,
        { type: 'text', delta: '答' },
        { type: 'text', delta: '案' },
        { type: 'turn_end', isError: false, forkPoint: 'native-turn-1' },
      ]}
    />,
  );
  expect(screen.getByText('答案')).toBeTruthy();
  // 只读：历史里不出现「从此处创建分支」这类交互入口。
  expect(screen.queryByText('从此处创建分支')).toBeNull();
});

it('工具调用与结果复用既有工具卡片', () => {
  render(
    <SessionTimeline
      events={[
        { type: 'tool_call', id: 'tool-1', name: 'Read', input: { file_path: 'src/example.py' } },
        { type: 'tool_result', id: 'tool-1', output: 'print(1)', isError: false },
        { type: 'turn_end', isError: false },
      ]}
    />,
  );
  expect(screen.getByText('读取文件')).toBeTruthy();
  expect(screen.getByText('src/example.py')).toBeTruthy();
});

it('Antigravity 不可回放时显示说明而不是空白', () => {
  render(<SessionTimeline events={[]} notReplayable />);
  expect(screen.getByText(/无法读取/)).toBeTruthy();
  expect(screen.queryByRole('log')).toBeNull();
});

it('读取失败时显示原因并可重试，不与不可回放混为一谈', () => {
  const retry = vi.fn();
  render(
    <SessionTimeline
      events={[]}
      error={{ kind: 'network', message: '无法连接本机服务，请确认后端已启动后重试。' }}
      onRetry={retry}
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain('无法连接本机服务');
  expect(screen.queryByText(/无法读取/)).toBeNull();
  screen.getByRole('button', { name: '重新读取' }).click();
  expect(retry).toHaveBeenCalledTimes(1);
});

it('只读历史不提供输入框，也不重复显示常驻说明', () => {
  render(<SessionTimeline events={[userEvent]} />);
  expect(screen.queryByText(/只读浏览原生会话记录/)).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('空标题显示占位', () => {
  render(<SessionHeader agent="claude" title="" version="2.1.317" projectDir="~/projects/demo" />);
  expect(screen.getByText('未命名会话')).toBeTruthy();
});

it('会话头显示 CLI、实际驱动版本、项目路径与运行状态', () => {
  const projectDir = path.resolve('fixtures', 'demo');
  render(<SessionHeader agent="codex" title="解释构建失败" version="0.166.0" projectDir={projectDir} running />);
  expect(screen.getByRole('heading', { name: '解释构建失败' })).toBeTruthy();
  expect(screen.getByText('Codex')).toBeTruthy();
  expect(screen.getByText('0.166.0')).toBeTruthy();
  expect(screen.getByText(projectDir)).toBeTruthy();
  expect(screen.getByText('运行中')).toBeTruthy();
});

it('CLI 徽标用首字母并保留完整名称', () => {
  render(<AgentBadge agent="antigravity" />);
  expect(screen.getByText('A')).toBeTruthy();
  expect(screen.getByTitle('Antigravity')).toBeTruthy();
});

it('历史图片使用记录的项目和 CLI，拒绝跨会话定位与临时上传身份', async () => {
  const scope = { workspaceId: 'history-project', agent: 'codex' as const, sessionId: 'history' };
  useChat.setState({
    workspaceId: 'active-project',
    agent: 'claude',
    sessionId: 'active',
    connection: 'open',
    attachmentIdentity: () => ({ token: 'owner', instanceId: 'instance' }),
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const locator = { sessionId: 'history', kind: 'user' as const, messageId: 'image', index: 0 };
  render(
    <SessionTimeline
      source={scope}
      events={[
        {
          type: 'user_message',
          text: '附件',
          attachments: [
            { kind: 'native-image', name: '记录图片', locator },
            { kind: 'native-image', name: '其他会话图片', locator: { ...locator, sessionId: 'other' } },
            { kind: 'image', id: 'temp', revision: 'r', mimeType: 'image/png', size: 3, name: '临时图片' },
          ],
        },
      ]}
    />,
  );
  await screen.findAllByText('这张原生图片当前不可读取。');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/workspaces/history-project/sessions/history/media?agent=codex&messageId=image&index=0&kind=user',
  ]);
});
