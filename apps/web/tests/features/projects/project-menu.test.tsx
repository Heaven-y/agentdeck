// @vitest-environment jsdom
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { Workspace } from '@agentdeck/shared/projects';
import { ProjectMenu } from '../../../src/features/projects/ProjectMenu';
import { revealLabel } from '../../../src/lib/desktop-bridge';

const project: Workspace = { id: 'demo', name: '原项目', dir: path.resolve('fixtures', 'demo') };
afterEach(() => {
  cleanup();
  delete window.agentDeck;
  vi.restoreAllMocks();
});

function mount(props: Parameters<typeof ProjectMenu>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProjectMenu {...props} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '管理项目“原项目”' }));
}

it('提供打开路径能力时显示“在资源管理器中打开”，点击后调到桌面接口', () => {
  const open = vi.fn();
  mount({ project, running: false, reveal: { label: revealLabel('win32'), open } });
  const item = screen.getByRole('menuitem', { name: '在资源管理器中打开' });
  fireEvent.click(item);
  expect(open).toHaveBeenCalledOnce();
});

it('没有打开路径能力时不显示该入口，也不再提供绑定服务器', () => {
  window.agentDeck = { platform: 'win32', selectDirectory: async () => null };
  mount({ project, running: false });
  expect(screen.queryByRole('menuitem', { name: /打开/ })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: /绑定服务器|修改服务器绑定/ })).toBeNull();
});

it('平台不同时按钮文案跟着变，浏览器环境用中性说法', () => {
  expect(revealLabel('win32')).toBe('在资源管理器中打开');
  expect(revealLabel('darwin')).toBe('在访达中显示');
  expect(revealLabel('linux')).toBe('在文件管理器中打开');
  expect(revealLabel(undefined)).toBe('在文件管理器中打开');
});
