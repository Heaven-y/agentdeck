// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NativeSkillsPanel from '../../../src/features/settings/NativeSkillsPanel';
import type { NativeSkillsCatalog } from '@agentdeck/shared/settings';
const catalog: NativeSkillsCatalog = {
  agent: 'claude',
  entries: [
    {
      id: 'demo',
      name: 'demo',
      scope: 'project',
      origin: 'owned',
      source: '.claude/skills/demo/SKILL.md',
      state: 'inherit',
      revision: 'revision',
      resourceId: 'demo',
      description: '同名技能共享可见性设置',
      actions: {
        edit: true,
        delete: true,
        states: ['inherit', 'on', 'name-only', 'user-invocable-only', 'off'],
        stateScopes: ['user', 'project', 'local'],
      },
    },
  ],
  roots: [],
  warnings: [],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('四态与继承保持原生语义，失败后保留用户选择，删除必须显式确认', async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    requests.push({ url: input as string, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return init?.method === 'POST'
      ? Response.json({ message: '文件已被修改' }, { status: 409 })
      : Response.json(catalog);
  });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(
    <NativeSkillsPanel
      context={{ agent: 'claude', projectId: 'project' }}
      reload={0}
      onEdit={vi.fn()}
      onCreate={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  await screen.findByText('demo');
  fireEvent.change(screen.getByLabelText('demo 可见性'), { target: { value: 'user-invocable-only' } });
  fireEvent.click(screen.getByRole('button', { name: '应用 demo 设置' }));
  await screen.findByText('文件已被修改');
  expect(screen.getByLabelText<HTMLSelectElement>('demo 可见性').value).toBe('user-invocable-only');
  fireEvent.click(screen.getByRole('button', { name: '删除 demo' }));
  expect(window.confirm).toHaveBeenCalled();
  await waitFor(() => expect(requests.filter((r) => r.body)).toHaveLength(1));
  expect(requests.find((r) => r.body)?.body).toMatchObject({
    id: 'demo',
    action: 'state',
    value: 'user-invocable-only',
    scope: 'project',
  });
});

function changingCatalog() {
  let current: NativeSkillsCatalog = {
    ...catalog,
    entries: [{ ...catalog.entries[0]!, state: 'on', revision: 'original' }],
  };
  const requests: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init?.method === 'POST') {
      requests.push(JSON.parse(init.body as string));
      return Response.json({ message: '文件已被修改' }, { status: 409 });
    }
    return Response.json(current);
  });
  const props = {
    context: { agent: 'claude' as const },
    reload: 0,
    onEdit: vi.fn(),
    onCreate: vi.fn(),
    onChanged: vi.fn(),
  };
  const result = render(<NativeSkillsPanel {...props} />);
  return {
    requests,
    refresh: () => {
      current = { ...current, entries: [{ ...current.entries[0]!, state: 'off', revision: 'updated' }] };
      result.rerender(<NativeSkillsPanel {...props} reload={1} />);
    },
  };
}
it('未编辑状态在刷新后同步最新值，不会以新revision重新提交旧选择', async () => {
  const { requests, refresh } = changingCatalog();
  await screen.findByText('demo');
  refresh();
  await screen.findByText('自有目录 · 当前项目 · 隐藏并停用');
  expect(screen.getByLabelText<HTMLSelectElement>('demo 可见性').value).toBe('off');
  fireEvent.click(screen.getByRole('button', { name: '应用 demo 设置' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ revision: 'updated', value: 'off' });
});
it('刷新保留真实草稿与原始revision，明确放弃后才采用最新设置', async () => {
  const { requests, refresh } = changingCatalog();
  await screen.findByText('demo');
  fireEvent.change(screen.getByLabelText('demo 可见性'), { target: { value: 'name-only' } });
  refresh();
  await screen.findByText('自有目录 · 当前项目 · 隐藏并停用');
  expect(screen.getByLabelText<HTMLSelectElement>('demo 可见性').value).toBe('name-only');
  fireEvent.click(screen.getByRole('button', { name: '应用 demo 设置' }));
  await screen.findByText('文件已被修改');
  expect(requests[0]).toMatchObject({ revision: 'original', value: 'name-only' });
  fireEvent.click(screen.getByRole('button', { name: '放弃 demo 草稿并采用最新设置' }));
  expect(screen.getByLabelText<HTMLSelectElement>('demo 可见性').value).toBe('off');
});
