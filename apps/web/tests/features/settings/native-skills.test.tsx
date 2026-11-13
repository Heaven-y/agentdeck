// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NativeSkillsPanel from '../../../src/features/settings/NativeSkillsPanel';
import { NativeSkillImport } from '../../../src/features/settings/NativeSkillImport';
import {
  guardSettingsNavigation,
  SettingsNavigationContext,
  type SettingsNavigation,
} from '../../../src/features/settings/settings-navigation';
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
it('新建或编辑另一技能时先保护同页导入与其他可见性草稿', async () => {
  const guards: SettingsNavigation = new Map();
  const edit = vi.fn(),
    create = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      ...catalog,
      entries: [...catalog.entries, { ...catalog.entries[0]!, id: 'other', name: 'other', resourceId: 'other' }],
      roots: [
        {
          id: 'root',
          kind: 'skills',
          scope: 'user',
          label: '用户技能',
          displayPath: '~/.claude/skills',
          editable: true,
        },
      ],
    }),
  );
  render(
    <SettingsNavigationContext value={guards}>
      <NativeSkillsPanel context={{ agent: 'claude' }} reload={0} onEdit={edit} onCreate={create} onChanged={vi.fn()} />
    </SettingsNavigationContext>,
  );
  fireEvent.click(await screen.findByText('导入本地技能目录'));
  fireEvent.change(screen.getByLabelText('导入技能名称'), { target: { value: 'draft-import' } });
  fireEvent.click(screen.getByRole('button', { name: '新建 Skill · 用户' }));
  fireEvent.click(screen.getAllByRole('button', { name: '编辑 SKILL.md' })[1]!);
  expect(create).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
  expect(screen.getByLabelText<HTMLInputElement>('导入技能名称').value).toBe('draft-import');
  fireEvent.change(screen.getByLabelText('导入技能名称'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('demo 可见性'), { target: { value: 'off' } });
  fireEvent.click(screen.getAllByRole('button', { name: '编辑 SKILL.md' })[1]!);
  expect(edit).not.toHaveBeenCalled();
  confirm.mockClear().mockReturnValue(true);
  fireEvent.click(screen.getAllByRole('button', { name: '编辑 SKILL.md' })[1]!);
  expect(edit).toHaveBeenCalledWith('other');
  expect(confirm).toHaveBeenCalledOnce();
});
it('技能目录与名称草稿保护统一导航，目录编码期间无法离开，成功后清除保护', async () => {
  const guards: SettingsNavigation = new Map();
  const navigate = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
  let finish!: (buffer: ArrayBuffer) => void;
  const file = new File(['合成技能'], 'SKILL.md');
  Object.defineProperty(file, 'webkitRelativePath', { value: 'demo/SKILL.md' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise((resolve) => (finish = resolve)) });
  render(
    <SettingsNavigationContext value={guards}>
      <NativeSkillImport
        context={{ agent: 'claude' }}
        roots={[
          {
            id: 'root',
            kind: 'skills',
            scope: 'user',
            label: '用户技能',
            displayPath: '~/.claude/skills',
            editable: true,
          },
        ]}
        onChanged={vi.fn()}
      />
    </SettingsNavigationContext>,
  );
  fireEvent.click(screen.getByText('导入本地技能目录'));
  fireEvent.change(screen.getByLabelText('导入技能名称'), { target: { value: 'draft-name' } });
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText('选择本地技能目录'), { target: { files: [file] } });
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }));
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => finish(new TextEncoder().encode('合成技能').buffer));
  await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('导入技能名称').value).toBe(''));
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).toHaveBeenCalledOnce();
});
it('技能可见性草稿保护统一导航与原文跳转，应用期间阻止离开，成功后解除', async () => {
  const guards: SettingsNavigation = new Map();
  const navigate = vi.fn();
  const edit = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
    init?.method === 'POST' ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(Response.json(catalog)),
  );
  render(
    <SettingsNavigationContext value={guards}>
      <NativeSkillsPanel
        context={{ agent: 'claude' }}
        reload={0}
        onEdit={edit}
        onCreate={vi.fn()}
        onChanged={vi.fn()}
      />
    </SettingsNavigationContext>,
  );
  await screen.findByText('demo');
  fireEvent.change(screen.getByLabelText('demo 可见性'), { target: { value: 'off' } });
  act(() => guardSettingsNavigation(guards, navigate));
  fireEvent.click(screen.getByRole('button', { name: '编辑 SKILL.md' }));
  expect(navigate).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText<HTMLSelectElement>('demo 可见性').value).toBe('off');
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '编辑 SKILL.md' }));
  expect(edit).toHaveBeenCalledWith('demo');
  fireEvent.click(screen.getByRole('button', { name: '应用 demo 设置' }));
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => finish(Response.json({})));
  await screen.findByText('已保存，下轮使用更新后的原生资源。');
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).toHaveBeenCalledOnce();
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
