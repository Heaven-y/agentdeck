// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectSessionRow } from '../../../src/features/sessions/ProjectSessionRow';
import { SessionLinkNotice, useSessionLinkCopy } from '../../../src/features/sessions/use-session-link-copy';

const session = { agent: 'claude' as const, sessionId: 'native-1', title: '示例' };

function CopyLink() {
  const copy = useSessionLinkCopy('project-1');
  return (
    <>
      <button type="button" onClick={() => void copy.copy(session)}>
        复制
      </button>
      <SessionLinkNotice notice={copy.notice} link={copy.link} />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('复制稳定链接后浮动提示且保留焦点；重复复制重新计时后自动消失', async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const { container } = render(<CopyLink />);
  const button = screen.getByRole('button', { name: '复制' });
  button.focus();
  await act(async () => fireEvent.click(button));
  expect(writeText).toHaveBeenLastCalledWith('agentdeck://session?workspace=project-1&agent=claude&id=native-1');
  const tip = screen.getByRole('status');
  expect(tip.textContent).toBe('会话链接已复制');
  expect(container.contains(tip)).toBe(false);
  expect(document.activeElement).toBe(button);
  expect(screen.queryByRole('textbox')).toBeNull();

  act(() => {
    vi.advanceTimersByTime(1000);
  });
  await act(async () => fireEvent.click(button));
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByRole('status').textContent).toBe('会话链接已复制');
  act(() => {
    vi.advanceTimersByTime(500);
  });
  expect(screen.queryByRole('status')).toBeNull();
});

it('剪贴板不可用时保留手动复制框，聚焦后选中完整链接', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  const { container } = render(<CopyLink />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制' })));
  expect(screen.getByRole('status').textContent).toContain('手动复制');
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '手动复制会话引用' });
  expect(container.contains(input)).toBe(true);
  expect(input.value).toBe('agentdeck://session?workspace=project-1&agent=claude&id=native-1');
  input.focus();
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
});

it('较早复制请求的失败不能覆盖最新成功提示', async () => {
  let rejectFirst!: (error: Error) => void;
  const firstWrite = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const writeText = vi.fn().mockReturnValueOnce(firstWrite).mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const { result } = renderHook(() => useSessionLinkCopy('project-1'));
  let firstCopy!: Promise<void>;
  act(() => {
    firstCopy = result.current.copy(session);
  });
  await act(() => result.current.copy({ ...session, sessionId: 'native-2' }));
  await act(async () => {
    rejectFirst(new Error('denied'));
    await firstCopy;
  });
  expect(result.current.notice).toBe('会话链接已复制');
  expect(result.current.link).toBe('');
});

it.each([false, true])('卸载时清理提示计时，未完成复制也不能再启动计时（等待中：%s）', async (pending) => {
  vi.useFakeTimers();
  let finish!: () => void;
  const writing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockReturnValue(writing) } });
  const { result, unmount } = renderHook(() => useSessionLinkCopy('project-1'));
  let copying!: Promise<void>;
  act(() => {
    copying = result.current.copy(session);
  });
  if (!pending) {
    await act(async () => {
      finish();
      await copying;
    });
    expect(vi.getTimerCount()).toBe(1);
  }
  unmount();
  await act(async () => {
    finish();
    await copying;
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('项目会话行的复制入口也显示浮层，不插入列表行或抢走菜单按钮焦点', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  render(
    <ul>
      <ProjectSessionRow
        session={{ ...session, projectId: 'project-1', running: false, updatedAt: new Date(1).toISOString() }}
        workspaceId="project-1"
        active={false}
        manage={vi.fn()}
      />
    </ul>,
  );
  const more = screen.getByRole('button', { name: /更多操作/ });
  fireEvent.click(more);
  fireEvent.click(await screen.findByRole('menuitem', { name: '复制会话链接' }));
  const tip = await screen.findByRole('status');
  expect(tip.textContent).toBe('会话链接已复制');
  expect(screen.getByRole('listitem').contains(tip)).toBe(false);
  expect(document.activeElement).toBe(more);
});
