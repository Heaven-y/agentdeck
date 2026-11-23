// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import NativeSkillsPanel from '../../../../src/features/settings/skills/NativeSkillsPanel';
import { NativeSkillImport } from '../../../../src/features/settings/skills/NativeSkillImport';
import {
  guardSettingsNavigation,
  SettingsNavigationContext,
  type SettingsNavigation,
} from '../../../../src/features/settings/navigation/settings-navigation';
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
it('独立详情不会堆叠，返回添加页和技能列表前保留草稿', async () => {
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
          scope: 'project',
          label: '项目技能',
          displayPath: '~/.claude/skills',
          editable: true,
        },
      ],
    }),
  );
  render(
    <SettingsNavigationContext value={guards}>
      <NativeSkillsPanel
        context={{ agent: 'claude', projectId: 'project' }}
        reload={0}
        onEdit={edit}
        onCreate={create}
        onChanged={vi.fn()}
      />
    </SettingsNavigationContext>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '添加技能' }));
  fireEvent.click(screen.getByRole('button', { name: '导入本地技能目录' }));
  fireEvent.change(screen.getByLabelText('导入技能名称'), { target: { value: 'draft-import' } });
  fireEvent.click(screen.getByRole('button', { name: '返回添加' }));
  expect(screen.getByLabelText<HTMLInputElement>('导入技能名称').value).toBe('draft-import');
  expect(screen.queryByRole('button', { name: '新建技能' })).toBeNull();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '返回添加' }));
  fireEvent.click(screen.getByRole('button', { name: '新建技能' }));
  expect(create).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  fireEvent.click(screen.getByRole('button', { name: 'demo' }));
  fireEvent.change(screen.getByLabelText('demo 可见性'), { target: { value: 'off' } });
  confirm.mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  expect(screen.queryByRole('button', { name: 'other' })).toBeNull();
  expect(screen.getByLabelText<HTMLInputElement>('demo 可见性').value).toBe('off');
  confirm.mockClear().mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  fireEvent.click(screen.getByRole('button', { name: 'other' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑 SKILL.md' }));
  expect(edit).toHaveBeenCalledWith('other', 'other', expect.stringMatching(/SKILL.md$/));
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
        onBack={vi.fn()}
      />
    </SettingsNavigationContext>,
  );
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
it('默认目录不平铺套件子技能与其他来源，但可从详情、搜索或来源切换找到', async () => {
  const entry = { ...catalog.entries[0]!, scope: 'user' as const };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      ...catalog,
      entries: [
        entry,
        { ...entry, id: 'child', name: 'child', parentSkillId: 'demo' },
        { ...entry, id: 'plugin', name: 'plugin-skill', origin: 'plugin' },
        { ...entry, id: 'builtin', name: 'builtin-skill', origin: 'builtin' },
      ],
    }),
  );
  render(
    <NativeSkillsPanel
      context={{ agent: 'claude' }}
      reload={0}
      onEdit={vi.fn()}
      onCreate={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  const bundle = await screen.findByRole('button', { name: 'demo' });
  expect(screen.queryByRole('button', { name: /child|plugin-skill|builtin-skill/ })).toBeNull();
  fireEvent.click(bundle);
  fireEvent.click(screen.getByRole('button', { name: 'child' }));
  expect(screen.getByRole('heading', { name: 'child' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回技能包' }));
  expect(screen.getByRole('heading', { name: 'demo' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索技能' }), { target: { value: 'child' } });
  expect(screen.getByRole('button', { name: 'child' })).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索技能' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /插件提供/ }));
  expect(screen.getByRole('button', { name: 'plugin-skill' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'demo' })).toBeNull();
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
        context={{ agent: 'claude', projectId: 'project' }}
        reload={0}
        onEdit={edit}
        onCreate={vi.fn()}
        onChanged={vi.fn()}
      />
    </SettingsNavigationContext>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  fireEvent.change(screen.getByLabelText('demo 可见性'), { target: { value: 'off' } });
  act(() => guardSettingsNavigation(guards, navigate));
  fireEvent.click(screen.getByRole('button', { name: '编辑 SKILL.md' }));
  expect(navigate).not.toHaveBeenCalled();
  expect(edit).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText<HTMLSelectElement>('demo 可见性').value).toBe('off');
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '编辑 SKILL.md' }));
  expect(edit).toHaveBeenCalledWith('demo', 'demo', expect.stringMatching(/SKILL.md$/));
  fireEvent.click(screen.getByRole('button', { name: '应用 demo 设置' }));
  act(() => guardSettingsNavigation(guards, navigate));
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => finish(Response.json({})));
  await screen.findByText('已保存，下次对话生效。');
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
  fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
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
    context: { agent: 'claude' as const, projectId: 'project' },
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
  fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  refresh();
  await screen.findByText('隐藏并停用');
  expect(screen.getByLabelText<HTMLSelectElement>('demo 可见性').value).toBe('off');
  fireEvent.click(screen.getByRole('button', { name: '应用 demo 设置' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ revision: 'updated', value: 'off' });
});
it('刷新保留真实草稿与原始revision，明确放弃后才采用最新设置', async () => {
  const { requests, refresh } = changingCatalog();
  fireEvent.click(await screen.findByRole('button', { name: 'demo' }));
  fireEvent.change(screen.getByLabelText('demo 可见性'), { target: { value: 'name-only' } });
  refresh();
  await screen.findByText('隐藏并停用');
  expect(screen.getByLabelText<HTMLSelectElement>('demo 可见性').value).toBe('name-only');
  fireEvent.click(screen.getByRole('button', { name: '应用 demo 设置' }));
  await screen.findByText('文件已被修改');
  expect(requests[0]).toMatchObject({ revision: 'original', value: 'name-only' });
  fireEvent.click(screen.getByRole('button', { name: '放弃 demo 草稿并采用最新设置' }));
  expect(screen.getByLabelText<HTMLSelectElement>('demo 可见性').value).toBe('off');
});
