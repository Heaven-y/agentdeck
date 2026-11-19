// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentCapabilities, AgentModel } from '@agentdeck/shared/conversation';
import { DEFAULT_APPEARANCE, DEFAULT_SPOTLIGHT } from '@agentdeck/shared/settings';
import { ModelOptionsMenu } from '../../../../src/features/chat/models/ModelOptionsMenu';
import { sessionActionKey, useChat } from '../../../../src/features/chat/state/chat-store';
import { chatApi, chatKeys } from '../../../../src/features/chat/api';
import { settingsApi } from '../../../../src/features/settings/api';
import { useAgentCapabilities } from '../../../../src/features/chat/controls/use-agent-capabilities';

let client: QueryClient;
const models: AgentModel[] = Array.from({ length: 65 }, (_, index) => ({
  id: `model-${index}`,
  label: `候选${index}`,
  modelId: index === 64 ? 'custom-native' : `native-${index}`,
}));
beforeEach(() => {
  useChat.setState(useChat.getInitialState(), true);
  useChat.getState().selectWorkspace('project');
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(chatKeys.agentCapabilities('project', 'claude'), {
    agent: 'claude',
    discovered: true,
    models,
    entries: [],
    warnings: [],
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.spyOn(chatApi, 'agentCapabilities').mockImplementation(
    async (project, agent, _signal, sessionId) =>
      client.getQueryData<AgentCapabilities>(chatKeys.agentCapabilities(project, agent, sessionId)) ?? {
        agent,
        discovered: false,
        models: [],
        entries: [],
        warnings: [],
      },
  );
  vi.spyOn(settingsApi, 'readEnvironment').mockResolvedValue({ checkedAt: 1, tools: [] });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  render(
    <QueryClientProvider client={client}>
      <ModelOptionsMenu disabled={false} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '模型选项' }));
}

it('菜单只展示少量候选并优先保留当前选择，搜索能找到末尾真实型号且不重新发现', async () => {
  useChat.getState().setModel('model-64[1m]');
  const refresh = vi.spyOn(chatApi, 'refreshAgentCapabilities');
  mount();
  const group = await screen.findByRole('group', { name: '可选模型' });
  expect(within(group).getAllByRole('menuitemradio')).toHaveLength(20);
  expect(
    within(group)
      .getByRole('menuitemradio', { name: /custom-native/ })
      .getAttribute('aria-checked'),
  ).toBe('true');
  fireEvent.click(screen.getByRole('menuitem', { name: '搜索可见模型' }));
  const dialog = screen.getByRole('dialog', { name: '选择模型' });
  const search = within(dialog).getByRole('combobox', { name: '搜索模型' });
  fireEvent.change(search, { target: { value: 'custom-native' } });
  const option = await within(dialog).findByRole('option', { name: /custom-native/ });
  expect(within(dialog).getAllByRole('option')).toHaveLength(1);
  await waitFor(() => expect(screen.queryByRole('menu', { name: '模型选项菜单' })).toBeNull());
  search.focus();
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  await waitFor(() => expect(search.getAttribute('aria-activedescendant')).toBe(option.id));
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  await waitFor(() => expect(search.getAttribute('aria-activedescendant')).toBe(option.id));
  fireEvent.keyDown(search, { key: 'Enter' });
  fireEvent.keyUp(search, { key: 'Enter' });
  await waitFor(() => expect(useChat.getState().modelOverrides.claude).toBe('model-64'));
  expect(refresh).not.toHaveBeenCalled();
});

it('全部候选可继续展开，手填型号仍在菜单中保留，关闭搜索不改变选择', async () => {
  useChat.getState().setModel('manual-custom');
  mount();
  expect(await screen.findByRole('menuitemradio', { name: /manual-custom/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: '搜索可见模型' }));
  const dialog = screen.getByRole('dialog', { name: '选择模型' });
  expect(within(dialog).getAllByRole('option')).toHaveLength(50);
  fireEvent.click(within(dialog).getByRole('button', { name: '显示更多模型' }));
  expect(within(dialog).getAllByRole('option')).toHaveLength(66);
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭选择模型' }));
  expect(useChat.getState().modelOverrides.claude).toBe('manual-custom');
  await act(async () => undefined);
});

it('对话菜单应用显示范围且保留当前隐藏模型，不因筛选改变发送参数', async () => {
  useChat.getState().setDefaults({
    spotlight: DEFAULT_SPOTLIGHT,
    appearance: DEFAULT_APPEARANCE,
    defaultAgent: 'claude',
    resources: { intervalSeconds: 5, timeoutSeconds: 8 },
    modelVisibility: { claude: ['model-1'] },
  });
  useChat.getState().setModel('model-64');
  mount();
  const group = await screen.findByRole('group', { name: '可选模型' });
  expect(within(group).getAllByRole('menuitemradio')).toHaveLength(2);
  expect(
    within(group)
      .getByRole('menuitemradio', { name: /custom-native/ })
      .getAttribute('aria-checked'),
  ).toBe('true');
  expect(within(group).getByRole('menuitemradio', { name: /native-1$/ })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: '搜索可见模型' })).toBeNull();
  expect(useChat.getState().modelOverrides.claude).toBe('model-64');
});

it('AGY 官方面板不继承 API Key 或旧的共用筛选，换回 API Key 仍按自己的范围显示', async () => {
  useChat.setState((state) => ({
    agent: 'antigravity',
    defaults: {
      ...state.defaults,
      modelVisibility: { antigravity: ['gemini-fixture-high'], 'antigravity-gemini': ['gemini-fixture-high'] },
    },
  }));
  const key = chatKeys.agentCapabilities('project', 'antigravity');
  const catalog = {
    agent: 'antigravity',
    discovered: true,
    models: [
      { id: 'gemini-fixture-high', label: 'Gemini Fixture (High)' },
      { id: 'gemini-fixture-low', label: 'Gemini Fixture (Low)' },
    ],
    defaultModel: 'gemini-fixture-high',
    entries: [],
    warnings: [],
  };
  client.setQueryData(key, { ...catalog, antigravityConnection: 'account' });
  mount();
  const group = await screen.findByRole('group', { name: '可选模型' });
  expect(within(group).getAllByRole('menuitemradio')).toHaveLength(2);
  expect(screen.queryByText(/模型未显示/)).toBeNull();

  client.setQueryData(key, { ...catalog, antigravityConnection: 'gemini' });
  await waitFor(() => expect(within(group).getAllByRole('menuitemradio')).toHaveLength(1));
  expect(screen.getByRole('status').textContent).toMatch(/已隐藏 1 个模型.*设置 → 模型/);
  expect(useChat.getState().modelOverrides.antigravity).toBe('');
});

it('只有 AGY 官方连接可点选读取额度，不把 API Key 或回合 token 当作账号额度', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      checkedAt: 1795050000000,
      groups: [
        {
          name: '官方模型组',
          buckets: [
            { id: 'short', name: '短期额度', remainingFraction: 0 },
            { id: 'long', name: '长期额度', remainingFraction: 0.0004 },
          ],
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  useChat.setState({ agent: 'antigravity' });
  const key = chatKeys.agentCapabilities('project', 'antigravity');
  const catalog = { agent: 'antigravity', discovered: true, models: [], entries: [], warnings: [] };
  client.setQueryData(key, { ...catalog, antigravityConnection: 'gemini' });
  mount();
  expect(screen.queryByRole('menuitem', { name: '查看官方额度' })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();

  await waitFor(() => expect(client.isFetching({ queryKey: key })).toBe(0));
  client.setQueryData(key, { ...catalog, antigravityConnection: 'account' });
  const entry = await screen.findByRole('menuitem', { name: '查看官方额度' });
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(entry);
  const dialog = await screen.findByRole('dialog', { name: 'Antigravity 官方额度' });
  await within(dialog).findByText('0%');
  expect(within(dialog).getByText('<0.1%')).toBeTruthy();
  expect(within(dialog).getAllByText('重置时间未报告')).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    '/api/settings/models/antigravity/official-usage',
    expect.objectContaining({ method: 'POST' }),
  );
  let respond!: (response: Response) => void;
  fetcher.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      respond = resolve;
    }),
  );
  fireEvent.click(within(dialog).getByRole('button', { name: '刷新额度' }));
  expect(within(dialog).getByText('<0.1%')).toBeTruthy();
  expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '正在刷新…' }).disabled).toBe(true);
  respond(
    Response.json({
      checkedAt: 1795050010000,
      groups: [{ name: '官方模型组', buckets: [{ id: 'short', name: '短期额度', remainingFraction: 0.5 }] }],
    }),
  );
  await within(dialog).findByText('50%');
  expect(within(dialog).queryByText('<0.1%')).toBeNull();
});

it.each([
  ['account', 'gemini'],
  [undefined, 'account'],
] as const)('AGY 菜单重开本机复核 %s → %s，不重新发现', async (initial, next) => {
  useChat.setState({ agent: 'antigravity' });
  const catalog = { agent: 'antigravity', discovered: true, models: [], entries: [], warnings: [] } as const;
  client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity'), {
    ...catalog,
    antigravityConnection: initial,
    models: [],
  });
  const refresh = vi.spyOn(chatApi, 'refreshAgentCapabilities');
  mount();
  const menu = await screen.findByRole('menu', { name: '模型选项菜单' });
  expect(within(menu).queryByRole('menuitem', { name: '查看官方额度' }) !== null).toBe(initial === 'account');
  const trigger = screen.getByRole('button', { name: '模型选项' });
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.queryByRole('menu', { name: '模型选项菜单' })).toBeNull());
  vi.mocked(chatApi.agentCapabilities).mockResolvedValue({
    ...catalog,
    antigravityConnection: next,
    models: [],
    entries: [],
    warnings: [],
  });
  fireEvent.click(trigger);
  await screen.findByText(next === 'account' ? '模型 · 官方登录' : '模型 · Gemini API Key');
  expect(screen.queryByRole('menuitem', { name: '查看官方额度' }) !== null).toBe(next === 'account');
  expect(refresh).not.toHaveBeenCalled();
});

it('AGY 原生连接仍未知时，菜单重复打开只读本机状态，不重复触发发现', async () => {
  useChat.setState({ agent: 'antigravity' });
  const key = chatKeys.agentCapabilities('project', 'antigravity');
  const unknown = { agent: 'antigravity' as const, discovered: false, models: [], entries: [], warnings: [] };
  client.setQueryData(key, { ...unknown, discovered: true });
  const read = vi.mocked(chatApi.agentCapabilities).mockResolvedValue(unknown);
  const refresh = vi.spyOn(chatApi, 'refreshAgentCapabilities').mockResolvedValue({ ...unknown, discovered: true });
  mount();
  const trigger = screen.getByRole('button', { name: '模型选项' });
  await screen.findByRole('menu', { name: '模型选项菜单' });
  await waitFor(() => expect(client.isFetching({ queryKey: key })).toBe(0));
  const count = read.mock.calls.length;
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.queryByRole('menu', { name: '模型选项菜单' })).toBeNull());
  fireEvent.click(trigger);
  await waitFor(() => expect(read.mock.calls.length).toBe(count + 1));
  await waitFor(() => expect(client.isFetching({ queryKey: key })).toBe(0));
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByRole('menuitem', { name: '查看官方额度' })).toBeNull();
});

it('成功目录被回收后允许重新发现，读取与手动刷新仍由各自缓存状态触发', async () => {
  const key = chatKeys.agentCapabilities('project', 'claude');
  client.removeQueries({ queryKey: key });
  const empty = { agent: 'claude' as const, discovered: false, models: [], entries: [], warnings: [] };
  vi.spyOn(chatApi, 'agentCapabilities').mockResolvedValue(empty);
  const refresh = vi
    .spyOn(chatApi, 'refreshAgentCapabilities')
    .mockResolvedValue({ ...empty, discovered: true, models });
  const mountHook = () =>
    renderHook(() => useAgentCapabilities(true, true), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
  const first = mountHook();
  await waitFor(() => expect(first.result.current.data?.models).toHaveLength(65));
  first.unmount();
  client.removeQueries({ queryKey: key });
  const second = mountHook();
  await waitFor(() => expect(second.result.current.data?.models).toHaveLength(65));
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('AGY 菜单与搜索都只显示一次同一模型，打开、检索和选择不改用另一配置入口', async () => {
  const native = { id: 'gemini-example-high', label: 'Gemini Example (High)' };
  const alias = { id: 'configured', label: native.label, modelId: native.label };
  useChat.getState().setAgent('antigravity');
  useChat.getState().setModel(alias.id);
  client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity'), {
    agent: 'antigravity',
    discovered: true,
    models: [native, alias, ...models],
    entries: [],
    warnings: [],
  });
  mount();
  const group = await screen.findByRole('group', { name: '可选模型' });
  expect(within(group).getByRole('menuitemradio', { name: native.label }).getAttribute('aria-checked')).toBe('true');
  expect(within(group).queryByRole('menuitemradio', { name: native.id })).toBeNull();
  expect(useChat.getState().modelOverrides.antigravity).toBe(alias.id);
  fireEvent.click(screen.getByRole('menuitem', { name: '搜索可见模型' }));
  const dialog = screen.getByRole('dialog', { name: '选择模型' });
  const search = within(dialog).getByRole('combobox', { name: '搜索模型' });
  fireEvent.change(search, { target: { value: native.id } });
  const option = await within(dialog).findByRole('option', { name: native.label });
  expect(within(dialog).getAllByRole('option')).toHaveLength(1);
  expect(option.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(option);
  expect(useChat.getState().modelOverrides.antigravity).toBe(alias.id);
  await act(async () => undefined);
});

it.each(['单条原生条目', '同型号的多个配置入口', '单条配置入口'])(
  'AGY %s 以名称继承时，型号展示和原选择保持稳定',
  async (scenario) => {
    const native = { id: 'gemini-example-high', label: 'Gemini Example (High)' };
    const configured = ['first-config', 'second-config'].map((id) => ({
      id,
      label: native.label,
      modelId: native.id,
    }));
    useChat.getState().setAgent('antigravity');
    useChat.setState({
      defaults: {
        ...useChat.getState().defaults,
        modelVisibility: { 'antigravity-gemini': [scenario === '单条配置入口' ? configured[0]!.id : native.id] },
      },
    });
    client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity'), {
      agent: 'antigravity',
      discovered: true,
      antigravityConnection: 'gemini',
      defaultModel: native.label,
      models:
        scenario === '单条原生条目'
          ? [native]
          : scenario === '单条配置入口'
            ? [configured[0]!]
            : [native, ...configured],
      entries: [],
      warnings: [],
    });
    render(
      <QueryClientProvider client={client}>
        <ModelOptionsMenu disabled={false} />
      </QueryClientProvider>,
    );
    const trigger = screen.getByRole('button', { name: '模型选项' });
    expect(trigger.textContent).toBe(native.id);
    expect(useChat.getState().modelOverrides.antigravity).toBe('');
    fireEvent.click(trigger);
    const group = await screen.findByRole('group', { name: '可选模型' });
    const current = within(group).getByRole('menuitemradio', { name: native.id });
    expect(within(group).getAllByRole('menuitemradio')).toEqual([current]);
    expect(current.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(current);
    expect(useChat.getState().modelOverrides.antigravity).toBe(native.label);
    expect(trigger.textContent).toBe(native.id);
    await waitFor(() => expect(screen.queryByRole('menu', { name: '模型选项菜单' })).toBeNull());
    fireEvent.click(trigger);
    const reopened = await screen.findByRole('group', { name: '可选模型' });
    expect(within(reopened).getAllByRole('menuitemradio')).toHaveLength(1);
    expect(within(reopened).getByRole('menuitemradio', { name: native.id }).getAttribute('aria-checked')).toBe('true');
    expect(useChat.getState().modelOverrides.antigravity).toBe(native.label);
  },
);

it('AGY 当前显示名与缓存型号合为一行，点选及重新打开均保留原选择', async () => {
  const native = { id: 'gemini-example-high', label: 'Gemini Example (High)' };
  const other = { id: 'gemini-other-high', label: 'Gemini Other (High)' };
  const overrides = ['old-config', 'window-config', 'saved-config'].map((id) => ({
    id,
    label: native.label,
    modelId: native.id,
  }));
  useChat.getState().setAgent('antigravity');
  useChat.setState({
    defaults: { ...useChat.getState().defaults, modelVisibility: { 'antigravity-gemini': [native.id, other.id] } },
  });
  client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity'), {
    agent: 'antigravity',
    discovered: true,
    antigravityConnection: 'gemini',
    defaultModel: native.label,
    models: [native, { id: native.label, label: native.label }, ...overrides, other],
    entries: [],
    warnings: [],
  });
  mount();
  const group = await screen.findByRole('group', { name: '可选模型' });
  expect(within(group).getAllByRole('menuitemradio')).toHaveLength(2);
  const current = within(group).getByRole('menuitemradio', { name: native.id });
  expect(current.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('button', { name: '模型选项' }).textContent).toContain(native.id);
  expect(useChat.getState().modelOverrides.antigravity).toBe('');
  fireEvent.click(current);
  expect(useChat.getState().modelOverrides.antigravity).toBe(native.label);
  await waitFor(() => expect(screen.queryByRole('menu', { name: '模型选项菜单' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '模型选项' }));
  const reopened = await screen.findByRole('group', { name: '可选模型' });
  expect(within(reopened).getAllByRole('menuitemradio')).toHaveLength(2);
  expect(within(reopened).getByRole('menuitemradio', { name: native.id }).getAttribute('aria-checked')).toBe('true');
  expect(useChat.getState().modelOverrides.antigravity).toBe(native.label);
});

it.each(['运行报告', '历史名称', '回退报告'])('AGY %s 与其他条目键重名时选择正确配置', async (source) => {
  const label = 'Example Display Name';
  const other = { id: label, label: 'Other Model', modelId: 'other-model' };
  const target = { id: 'target-config', label, modelId: 'target-model' };
  useChat.getState().setAgent('antigravity');
  useChat.setState({
    sessionId: 'history',
    running: source === '运行报告',
    actualModel: source === '历史名称' ? undefined : label,
    sessionModels: {
      [sessionActionKey('project', { agent: 'antigravity', sessionId: 'history' })]: {
        nativeModel: source === '历史名称' ? label : undefined,
      },
    },
  });
  client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity', 'history'), {
    agent: 'antigravity',
    discovered: true,
    defaultModel: source === '运行报告' ? label : undefined,
    models: [other, target, ...models],
    entries: [],
    warnings: [],
  });
  mount();
  const trigger = screen.getByRole('button', { name: '模型选项' });
  expect(trigger.textContent).toBe('target-model');
  const group = await screen.findByRole('group', { name: '可选模型' });
  expect(within(group).getByRole('menuitemradio', { name: 'other-model' }).getAttribute('aria-checked')).toBe('false');
  const selected = within(group).getByRole('menuitemradio', { name: 'target-model' });
  expect(selected.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(selected);
  expect(useChat.getState().modelOverrides.antigravity).toBe('target-config');
  expect(trigger.textContent).toBe('target-model');
  await waitFor(() => expect(screen.queryByRole('menu', { name: '模型选项菜单' })).toBeNull());
  fireEvent.click(trigger);
  expect((await screen.findByRole('menuitemradio', { name: 'target-model' })).getAttribute('aria-checked')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('menuitem', { name: '搜索可见模型' }));
  const dialog = screen.getByRole('dialog', { name: '选择模型' });
  fireEvent.change(within(dialog).getByRole('combobox', { name: '搜索模型' }), { target: { value: 'target-model' } });
  const option = await within(dialog).findByRole('option', { name: 'target-model' });
  expect(option.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(option);
  expect(useChat.getState().modelOverrides.antigravity).toBe('target-config');
});

it.each(['显式选择', '目录默认'])('AGY %s 与其他条目名称重名时仍按配置键解析', async (source) => {
  const label = 'Example Display Name';
  const other = { id: label, label: 'Other Model', modelId: 'other-model' };
  const target = { id: 'target-config', label, modelId: 'target-model' };
  useChat.getState().setAgent('antigravity');
  useChat.setState({
    sessionId: 'history',
    sessionModels: {
      [sessionActionKey('project', { agent: 'antigravity', sessionId: 'history' })]: { nativeModel: label },
    },
  });
  if (source === '显式选择') useChat.getState().setModel(label);
  client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity', 'history'), {
    agent: 'antigravity',
    discovered: true,
    defaultModel: source === '目录默认' ? label : undefined,
    models: [other, target],
    entries: [],
    warnings: [],
  });
  mount();
  expect(screen.getByRole('button', { name: '模型选项' }).textContent).toBe('other-model');
  const group = await screen.findByRole('group', { name: '可选模型' });
  expect(within(group).getByRole('menuitemradio', { name: 'other-model' }).getAttribute('aria-checked')).toBe('true');
  expect(within(group).getByRole('menuitemradio', { name: 'target-model' }).getAttribute('aria-checked')).toBe('false');
});

it('AGY 原生名称与其他配置的底层型号重名时，点选后仍保留正确身份', async () => {
  const label = 'Example Display Name';
  useChat.getState().setAgent('antigravity');
  useChat.setState({ sessionId: 'history', actualModel: label });
  client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity', 'history'), {
    agent: 'antigravity',
    discovered: true,
    models: [
      { id: 'other-config', label: 'Other Model', modelId: label },
      { id: 'target-config', label, modelId: 'target-model' },
    ],
    entries: [],
    warnings: [],
  });
  mount();
  const trigger = screen.getByRole('button', { name: '模型选项' });
  expect(trigger.textContent).toBe('target-model');
  const selected = await screen.findByRole('menuitemradio', { name: 'target-model' });
  expect(selected.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(selected);
  expect(useChat.getState().modelOverrides.antigravity).toBe('target-config');
  expect(trigger.textContent).toBe('target-model');
});

it.each(['原生型号', '配置底层型号', '原生型号与唯一配置', '底层型号与其他配置键重名'])(
  'AGY 报告%s时按真实型号识别',
  async (source) => {
    const modelId = 'reported-model';
    const native = { id: modelId, label: 'Native Model' };
    const target = { id: 'target-config', label: 'Target Model', modelId };
    const other = { id: modelId, label: 'Other Model', modelId: 'other-model' };
    const catalog =
      source === '原生型号'
        ? [native]
        : source === '配置底层型号'
          ? [target]
          : source === '原生型号与唯一配置'
            ? [native, { ...target, label: native.label }]
            : [other, target];
    useChat.getState().setAgent('antigravity');
    useChat.setState({ sessionId: 'history', actualModel: modelId });
    client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity', 'history'), {
      agent: 'antigravity',
      discovered: true,
      models: catalog,
      entries: [],
      warnings: [],
    });
    mount();
    const trigger = screen.getByRole('button', { name: '模型选项' });
    expect(trigger.textContent).toBe(modelId);
    const group = await screen.findByRole('group', { name: '可选模型' });
    const selected = within(group).getByRole('menuitemradio', { name: modelId });
    expect(selected.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(selected);
    expect(useChat.getState().modelOverrides.antigravity).toBe(
      source === '底层型号与其他配置键重名' ? target.id : modelId,
    );
    expect(trigger.textContent).toBe(modelId);
  },
);

it('AGY 原生报告只命中其他配置键时不误认为型号', async () => {
  const reported = 'reported-model';
  useChat.getState().setAgent('antigravity');
  useChat.setState({ sessionId: 'history', actualModel: reported });
  client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity', 'history'), {
    agent: 'antigravity',
    discovered: true,
    models: [{ id: reported, label: 'Other Model', modelId: 'other-model' }],
    entries: [],
    warnings: [],
  });
  mount();
  expect(screen.getByRole('button', { name: '模型选项' }).textContent).toBe(reported);
  expect((await screen.findByRole('menuitemradio', { name: 'other-model' })).getAttribute('aria-checked')).toBe(
    'false',
  );
});

it('AGY 原生名称对应不同型号时不猜型号或合并同名候选', async () => {
  const label = 'Shared';
  useChat.getState().setAgent('antigravity');
  useChat.setState({ sessionId: 'history', actualModel: label });
  client.setQueryData(chatKeys.agentCapabilities('project', 'antigravity', 'history'), {
    agent: 'antigravity',
    discovered: true,
    models: [
      { id: 'model-x', label },
      { id: label, label },
      { id: 'config-b', label, modelId: 'model-y' },
    ],
    entries: [],
    warnings: [],
  });
  mount();
  expect(screen.getByRole('button', { name: '模型选项' }).textContent).toBe(label);
  const group = await screen.findByRole('group', { name: '可选模型' });
  expect(within(group).getAllByRole('menuitemradio')).toHaveLength(3);
  for (const name of ['model-x', label, 'model-y'])
    expect(within(group).getByRole('menuitemradio', { name }).getAttribute('aria-checked')).toBe('false');
});
