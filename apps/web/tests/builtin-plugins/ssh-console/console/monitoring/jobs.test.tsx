// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SlurmSnapshot } from '@agentdeck/shared/ssh';
import { ConsoleJobs } from '../../../../../src/builtin-plugins/ssh-console/console/monitoring/ConsoleJobs';

let client: QueryClient;
let snapshots: SlurmSnapshot[];
let requested: string[];

function mount(active = true) {
  return render(
    <QueryClientProvider client={client}>
      <ConsoleJobs serverId="my-server" active={active} />
    </QueryClientProvider>,
  );
}

const snapshot = (over: Partial<SlurmSnapshot> = {}): SlurmSnapshot => ({
  sampledAt: 1,
  status: 'available',
  output: '',
  truncated: false,
  ...over,
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requested = [];
  snapshots = [snapshot()];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      requested.push(input);
      const next = snapshots.shift() ?? snapshot();
      return Response.json(next);
    }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('原样等宽显示 squeue 输出并标注采样时间', async () => {
  const table =
    '             JOBID PARTITION      NAME    USER ST   NODES\n              7       gpu    demo-job   demo  R       1';
  snapshots = [snapshot({ output: table })];
  mount();
  // 输出不二次拆列：整段文本进同一个 pre。
  expect((await screen.findByText(/demo-job/)).tagName).toBe('PRE');
  expect(screen.getByRole('region', { name: 'Slurm 作业' })).toBeTruthy();
  expect(screen.getByText(/采样于/)).toBeTruthy();
});

it('没有排队作业时说明当前账号为空，而不是显示空表格', async () => {
  mount();
  expect(await screen.findByText('当前账号没有排队中的作业。')).toBeTruthy();
});

it('未安装 Slurm 呈现为不可用说明，不伪装成空列表', async () => {
  snapshots = [snapshot({ status: 'unavailable', message: '未找到 squeue，请确认服务器已安装 Slurm' })];
  mount();
  expect(await screen.findByText('未找到 squeue，请确认服务器已安装 Slurm')).toBeTruthy();
  expect(screen.queryByText('当前账号没有排队中的作业。')).toBeNull();
});

it('查询失败以告警呈现，并说明截断', async () => {
  snapshots = [snapshot({ status: 'error', message: 'Slurm 查询失败，请检查账号权限或控制器状态' })];
  mount();
  expect((await screen.findByRole('alert')).textContent).toContain('Slurm 查询失败');
  cleanup();
  client.clear();
  snapshots = [snapshot({ output: 'job-line', truncated: true })];
  mount();
  expect(await screen.findByText('作业过多，只显示前 200 行。')).toBeTruthy();
});

it('不可见时不请求，切回可见才读取', async () => {
  mount(false);
  expect(screen.getByText('正在读取作业…')).toBeTruthy();
  expect(requested.some((url) => url.includes('/jobs'))).toBe(false);
  cleanup();
  client.clear();
  mount(true);
  expect(await screen.findByText('当前账号没有排队中的作业。')).toBeTruthy();
  expect(requested.some((url) => url.includes('/api/ssh-console/my-server/jobs'))).toBe(true);
});
