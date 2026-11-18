import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import type { SlurmSnapshot } from '@agentdeck/shared/ssh';
import { sshConsoleApi } from '../api';
import { consoleError } from '../navigation/console-state';

function JobsBody({ data }: { data?: SlurmSnapshot }) {
  if (!data) return <p className="text-sm text-muted-foreground">正在读取作业…</p>;
  if (data.status === 'unavailable')
    return (
      <p className="text-sm text-muted-foreground">{data.message ?? '未找到 squeue，请确认服务器已安装 Slurm。'}</p>
    );
  if (data.status === 'error')
    return (
      <p role="alert" className="text-sm text-destructive-foreground">
        {data.message ?? 'Slurm 查询失败，请检查连接后重试。'}
      </p>
    );
  if (!data.output) return <p className="text-sm text-muted-foreground">当前账号没有排队中的作业。</p>;
  return (
    <>
      {data.message && <p className="mb-2 text-xs text-muted-foreground">{data.message}</p>}
      <pre className="overflow-x-auto font-mono text-xs leading-5 whitespace-pre">{data.output}</pre>
      {data.truncated && <p className="mt-2 text-xs text-muted-foreground">作业过多，只显示前 200 行。</p>}
    </>
  );
}

/**
 * 当前登录账号的 squeue 只读快照。
 *
 * 输出是后端按固定列宽排好的文本，这里原样等宽显示：squeue 的字段宽度本身就是对齐的，
 * 前端再拆列只会引入第二套解释，遇到不认识的列就直接丢掉信息。
 */
export function ConsoleJobs({ serverId, active }: { serverId: string; active: boolean }) {
  const jobs = useQuery({
    queryKey: ['ssh-console', serverId, 'jobs'],
    queryFn: ({ signal }) => sshConsoleApi.jobs(serverId, signal),
    enabled: active,
    refetchInterval: active ? 10000 : false,
    retry: false,
  });
  const data = jobs.data;
  return (
    <section aria-label="Slurm 作业" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <h2 className="mr-auto flex items-center gap-2 text-sm font-medium">
          <ListChecks aria-hidden className="size-4 text-muted-foreground" />
          Slurm 作业
        </h2>
        {data?.sampledAt ? (
          <p className="text-xs text-muted-foreground">采样于 {new Date(data.sampledAt).toLocaleTimeString()}</p>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {jobs.error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {consoleError(jobs.error)}
          </p>
        ) : (
          <JobsBody data={data} />
        )}
      </div>
    </section>
  );
}
