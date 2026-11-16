import { expect, it } from 'vitest';
import { createSshConsoleService } from '../../../../src/builtin-plugins/ssh-console/console/service';
import { SLURM_COMMAND } from '../../../../src/builtin-plugins/ssh-console/console/slurm-command';
import { consoleFixture } from './console.fixture';

const slurmHeader =
  '             JOBID PARTITION                     NAME     USER ST       TIME  NODES NODELIST(REASON)';
const slurmLine = (id = 101) =>
  [
    String(id).padStart(18),
    'gpu'.padStart(9),
    'synthetic-job'.padStart(24),
    'demo'.padStart(8),
    'PD',
    '0:00'.padStart(10),
    '1'.padStart(6),
    '(Resources)',
  ].join(' ');

it('作业页读取当前账号的 squeue，补固定表头并保留原列宽', async () => {
  const f = consoleFixture();
  f.setExecOutput(() => `${slurmLine()}\n${slurmLine(102)}\n`);
  const service = createSshConsoleService(f);
  try {
    const snapshot = await service.jobs('my-server');
    expect(snapshot.status).toBe('available');
    expect(snapshot.output.split('\n')).toEqual([slurmHeader, slurmLine(), slurmLine(102)]);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.message).toBeUndefined();
    // 命令是固定的 squeue 只读查询，不拼用户输入。
    expect(f.commands).toEqual([{ serverId: 'my-server', command: SLURM_COMMAND }]);
  } finally {
    service.dispose();
  }
});

it('没有排队作业时返回可用但空输出，不伪造表头', async () => {
  const f = consoleFixture();
  f.setExecOutput(() => '');
  const service = createSshConsoleService(f);
  try {
    const snapshot = await service.jobs('my-server');
    expect(snapshot).toMatchObject({ status: 'available', output: '', truncated: false });
  } finally {
    service.dispose();
  }
});

it('未安装 squeue 与查询失败分别给出不可用和错误，不呈现为空列表', async () => {
  const f = consoleFixture();
  const service = createSshConsoleService(f);
  try {
    f.setExecResult(() => ({ exitCode: 127, stderr: '' }));
    expect(await service.jobs('my-server')).toMatchObject({
      status: 'unavailable',
      message: '未找到 squeue，请确认服务器已安装 Slurm',
      output: '',
    });

    // 换一台服务器，避免命中上一台 2 秒成功/失败缓存。
    f.setExecResult(() => ({ exitCode: 1, stderr: 'slurm_load_jobs error: Socket timed out' }));
    const failed = await service.jobs('other-server');
    expect(failed).toMatchObject({ status: 'error', output: '' });
    // 原始诊断不出后端：只回报固定文案，避免把远端 stderr 当作界面正文。
    expect(failed.message).toBe('Slurm 查询失败，请检查账号权限或控制器状态');
  } finally {
    service.dispose();
  }
});

it('成功但 stderr 非空时标记警告，输出仍然可用', async () => {
  const f = consoleFixture();
  f.setExecOutput(() => `${slurmLine()}\n`);
  f.setExecResult(() => ({ exitCode: 0, stderr: 'warning: something' }));
  const service = createSshConsoleService(f);
  try {
    const snapshot = await service.jobs('my-server');
    expect(snapshot).toMatchObject({ status: 'available', message: 'Slurm 返回警告，结果可能不完整' });
    expect(snapshot.output).toContain(slurmLine());
  } finally {
    service.dispose();
  }
});

it('输出超过 200 行时截断并明确标注', async () => {
  const f = consoleFixture();
  f.setExecOutput(() => Array.from({ length: 205 }, (_, index) => slurmLine(index + 1)).join('\n'));
  const service = createSshConsoleService(f);
  try {
    const snapshot = await service.jobs('my-server');
    expect(snapshot.truncated).toBe(true);
    // 表头 + 200 行：截断发生在行数预算，不是字节预算。
    expect(snapshot.output.split('\n')).toHaveLength(201);
  } finally {
    service.dispose();
  }
});

it('同一服务器第二次读取复用缓存，认证代次变化后重新查询', async () => {
  const f = consoleFixture();
  f.setExecOutput(() => `${slurmLine()}\n`);
  const service = createSshConsoleService(f);
  try {
    await service.jobs('my-server');
    await service.jobs('my-server');
    expect(f.commands).toHaveLength(1);

    f.invalidate('my-server');
    await service.jobs('my-server');
    expect(f.commands).toHaveLength(2);
  } finally {
    service.dispose();
  }
});

it('不同服务器各自查询，不共用排队结果', async () => {
  const f = consoleFixture();
  f.setExecOutput((serverId) => `${slurmLine(serverId === 'my-server' ? 101 : 202)}\n`);
  const service = createSshConsoleService(f);
  try {
    const first = await service.jobs('my-server');
    const second = await service.jobs('other-server');
    expect(first.output).toContain(slurmLine(101));
    expect(second.output).toContain(slurmLine(202));
    expect(f.commands.map(({ serverId }) => serverId)).toEqual(['my-server', 'other-server']);
  } finally {
    service.dispose();
  }
});

it('插件停用后拒绝读取，不返回上一代结果', async () => {
  const f = consoleFixture();
  f.setExecOutput(() => `${slurmLine()}\n`);
  const service = createSshConsoleService(f);
  try {
    await service.jobs('my-server');
    f.disable();
    await expect(service.jobs('my-server')).rejects.toMatchObject({ code: 'plugin_disabled' });
  } finally {
    service.dispose();
  }
});
