// @vitest-environment jsdom
import { EditorView } from '@uiw/react-codemirror';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { ProductSettingsSchema, type NativeResourceCatalog } from '@agentdeck/shared/settings';
import SettingsDialog from '../../../../src/features/settings/SettingsDialog';
import NativeResourcesDialog from '../../../../src/features/settings/resources/NativeResourcesDialog';
import {
  SettingsNavigationContext,
  guardSettingsNavigation,
  type SettingsNavigation,
} from '../../../../src/features/settings/navigation/settings-navigation';
import { queryClient } from '../../../../src/lib/query-client';

const resource = {
  id: 'user-rules',
  agent: 'antigravity',
  kind: 'rules',
  scope: 'user',
  label: '用户规则',
  displayPath: '~/.agents/rules/main.md',
  format: 'markdown',
  exists: true,
  editable: true,
  description: '用户级原生规则。',
} as const;
const pendingFile = {
  ...resource,
  id: 'gemini',
  label: 'GEMINI.md',
  displayPath: '~/.gemini/GEMINI.md',
  exists: false,
};
const catalog: NativeResourceCatalog = {
  agent: 'antigravity',
  entries: [resource, pendingFile],
  roots: [
    {
      id: 'user-skills',
      kind: 'skills',
      scope: 'user',
      label: '用户 Skills',
      displayPath: '~/.agents/skills',
      editable: true,
    },
  ],
  guidance: [{ label: '原生插件', description: '使用 CLI 管理插件。', command: 'antigravity plugin list' }],
  warnings: [],
};
let fetchMock: MockInstance<typeof fetch>;
const requests: Array<{ url: string; init?: RequestInit }> = [];

function editor() {
  return EditorView.findFromDOM(screen.getByRole('textbox', { name: '原生文件内容' }))!;
}
function edit(content: string) {
  const view = editor();
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } }));
}
async function openCatalog() {
  fireEvent.click(await screen.findByRole('button', { name: '模型与连接' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Antigravity' }));
  fireEvent.click(await screen.findByText('高级设置'));
  fireEvent.click(await screen.findByRole('button', { name: '编辑 Antigravity 配置文件' }));
  return screen.findByRole('heading', { name: '原生文件' });
}
beforeEach(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  requests.length = 0;
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input as string;
    requests.push({ url, init });
    if (url === '/api/settings/product')
      return Response.json({ settings: ProductSettingsSchema.parse({}), revision: 'missing' });
    if (url.startsWith('/api/settings/models/'))
      return Response.json({
        agent: url.split('/').at(-1),
        revision: 'missing',
        displayPath: 'settings.json',
        fields: [],
        warnings: [],
      });
    if (init?.method === 'PUT') return Response.json({ resource, revision: 'next' });
    if (url.includes('/open'))
      return Response.json({ resource, content: '# synthetic-private-rule\n', revision: 'original' });
    if (url.startsWith('/api/native-resources/')) return Response.json(catalog);
    throw new Error(`未声明的测试接口：${url}`);
  });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
});
afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  queryClient.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Range.prototype, 'getClientRects');
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
});

it('三个 CLI 共用资源入口，只读取全局原生资源，显式打开才读取正文且不缓存', async () => {
  render(<SettingsDialog onClose={vi.fn()} />);
  await openCatalog();
  await screen.findByText(resource.displayPath);
  expect(requests.some(({ url }) => url === '/api/native-resources/antigravity')).toBe(true);
  expect(requests.some(({ url }) => url.includes('/open'))).toBe(false);
  expect(screen.queryByRole('textbox', { name: '原生文件内容' })).toBeNull();
  expect(screen.queryByText('antigravity plugin list')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '文件说明' }));
  expect(screen.getByText('antigravity plugin list')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  expect(requests.filter(({ url }) => url === '/api/native-resources/antigravity')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '用户规则' }));
  await screen.findByRole('textbox', { name: '原生文件内容' });
  expect(editor().state.doc.toString()).toBe('# synthetic-private-rule\n');
  expect(requests.find(({ url }) => url.includes('/open'))).toMatchObject({
    url: '/api/native-resources/antigravity/user-rules/open',
    init: { method: 'POST', cache: 'no-store' },
  });
  expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain('synthetic-private-rule');
  fireEvent.click(screen.getByRole('button', { name: '返回资源目录' }));
  await screen.findByRole('heading', { name: '原生文件' });
  expect(screen.queryByRole('textbox', { name: '原生文件内容' })).toBeNull();
});

it('保存使用原修订，冲突保留正文；关闭、重读均保护未保存草稿', async () => {
  const close = vi.fn();
  const handle = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) =>
    init?.method === 'PUT'
      ? Response.json({ message: '文件已变化，请重新读取。' }, { status: 409 })
      : handle(input, init),
  );
  render(<SettingsDialog onClose={close} />);
  await openCatalog();
  fireEvent.click(await screen.findByRole('button', { name: '用户规则' }));
  await screen.findByRole('textbox', { name: '原生文件内容' });
  edit('# 我的规则\n');
  fireEvent.click(screen.getByRole('button', { name: '保存文件' }));
  await screen.findByRole('alert');
  expect(editor().state.doc.toString()).toBe('# 我的规则\n');
  const save = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(save[1]?.body as string)).toEqual({ content: '# 我的规则\n', revision: 'original' });
  fireEvent.click(screen.getByRole('button', { name: '重新读取文件' }));
  expect(requests.filter(({ url }) => url.includes('/open'))).toHaveLength(1);
  for (const name of ['通用设置', 'Codex']) {
    fireEvent.click(screen.getByRole('button', { name }));
    expect(editor().state.doc.toString()).toBe('# 我的规则\n');
  }
  expect(screen.queryByLabelText('资源范围')).toBeNull();
  expect(editor().state.doc.toString()).toBe('# 我的规则\n');
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
  expect(close).not.toHaveBeenCalled();
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('textbox', { name: '原生文件内容' })).toBeNull();
});

it('原生文件默认只列现有文件，预设文件和创建目录收在新建入口', async () => {
  render(<NativeResourcesDialog agent="antigravity" embedded onBack={vi.fn()} onClose={vi.fn()} />);
  await screen.findByText(resource.displayPath);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('navigation', { name: '原生资源分类' })).toBeNull();
  expect(screen.queryByRole('button', { name: '返回模型设置' })).toBeNull();
  expect(screen.queryByRole('button', { name: '关闭设置' })).toBeNull();
  expect(screen.queryByRole('button', { name: pendingFile.label })).toBeNull();
  expect(screen.queryByRole('button', { name: '新建 Skill' })).toBeNull();
  expect(screen.queryByText('文件已存在')).toBeNull();
  const create = screen.getByRole('button', { name: '新建文件' });
  fireEvent.click(create);
  expect(screen.getByRole('button', { name: pendingFile.label })).toBeTruthy();
  expect(screen.getByRole('button', { name: '新建 Skill' })).toBeTruthy();
  expect(requests.some(({ url }) => url.includes('/open'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  expect(document.activeElement).toBe(create);
  fireEvent.click(screen.getByRole('button', { name: '用户规则' }));
  await screen.findByRole('textbox', { name: '原生文件内容' });
  expect(screen.getByRole('heading', { name: '用户规则' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: '用户规则' }));
  expect(screen.getByRole('button', { name: '返回资源目录' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '关闭设置' })).toBeNull();
});

it('创建资源的草稿接入统一导航，取消保留填写内容，确认离开后清除', async () => {
  const navigation: SettingsNavigation = new Map();
  const leave = vi.fn();
  render(
    <SettingsNavigationContext.Provider value={navigation}>
      <NativeResourcesDialog agent="antigravity" embedded onBack={vi.fn()} onClose={vi.fn()} />
    </SettingsNavigationContext.Provider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: '新建文件' }));
  fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  const name = await screen.findByLabelText<HTMLInputElement>('Skill 名称');
  fireEvent.change(name, { target: { value: 'unsaved-skill' } });
  act(() => guardSettingsNavigation(navigation, leave));
  expect(leave).not.toHaveBeenCalled();
  expect(name.value).toBe('unsaved-skill');
  vi.mocked(window.confirm).mockReturnValue(true);
  act(() => guardSettingsNavigation(navigation, leave));
  expect(leave).toHaveBeenCalledTimes(1);
  expect(name.value).toBe('');
});

it('切换 CLI 取消正文请求并忽略旧上下文迟到的敏感内容', async () => {
  const handle = fetchMock.getMockImplementation()!;
  let resolve!: (response: Response) => void;
  fetchMock.mockImplementation(async (input, init) =>
    (input as string).includes('/open')
      ? new Promise((done) => {
          resolve = done;
        })
      : handle(input, init),
  );
  render(<SettingsDialog onClose={vi.fn()} />);
  await openCatalog();
  fireEvent.click(await screen.findByRole('button', { name: '用户规则' }));
  await screen.findByText('正在读取文件…');
  const open = fetchMock.mock.calls.find(([url]) => (url as string).includes('/open'))!;
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  await screen.findByRole('heading', { name: '原生文件' });
  expect(open[1]?.signal?.aborted).toBe(true);
  await act(async () => resolve(Response.json({ resource, content: 'late-sensitive-content', revision: 'late' })));
  expect(screen.queryByRole('textbox')).toBeNull();
  await waitFor(() => expect(screen.queryByText('late-sensitive-content')).toBeNull());
});

/** 整页集成用例在覆盖率并行门禁下受资源争抢；真实失败仍由各断言自身等待预算立即暴露。 */
it('只在服务端给出的Skill目录创建；正文带用户填写的元信息，创建成功不重复提交', async () => {
  const handle = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) =>
    init?.method === 'POST' && !(input as string).includes('/open')
      ? Response.json({
          resource: {
            ...resource,
            id: 'new-skill',
            kind: 'skills',
            displayPath: '~/.agents/skills/demo-skill/SKILL.md',
          },
          revision: 'saved',
        })
      : handle(input, init),
  );
  render(<SettingsDialog onClose={vi.fn()} />);
  await openCatalog();
  fireEvent.click(await screen.findByRole('button', { name: '新建文件' }));
  fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }));
  const name = await screen.findByLabelText('Skill 名称');
  fireEvent.change(screen.getByLabelText('Skill 用途'), { target: { value: '检查演示项目' } });
  const view = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Skill 使用说明' }))!;
  act(() => view.dispatch({ changes: { from: 0, insert: '# 检查要求\n先阅读项目说明。' } }));
  for (const invalid of ['Demo Skill', 'demo--skill', 'demo-', 'a'.repeat(65)]) {
    fireEvent.change(name, { target: { value: invalid } });
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '创建文件' }).disabled).toBe(true);
  }
  fireEvent.change(name, { target: { value: 'demo-skill' } });
  expect(name.getAttribute('aria-invalid')).not.toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '创建文件' }));
  await screen.findByText(/已创建：/);
  const created = fetchMock.mock.calls.find(
    ([url, init]) => (url as string).startsWith('/api/native-resources/') && init?.method === 'POST',
  )!;
  expect(created[0]).toBe('/api/native-resources/antigravity');
  expect(JSON.parse(created[1]?.body as string)).toEqual({
    rootId: 'user-skills',
    name: 'demo-skill',
    content: '---\nname: "demo-skill"\ndescription: "检查演示项目"\n---\n\n# 检查要求\n先阅读项目说明。',
  });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '创建文件' }).disabled).toBe(true);
}, 15000);
