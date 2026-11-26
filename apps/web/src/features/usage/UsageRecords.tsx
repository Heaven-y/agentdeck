import { useState } from 'react';
import { ListTree } from 'lucide-react';
import type { Workspace } from '@agentdeck/shared/projects';
import type { UsageRow } from '@agentdeck/shared/usage';
import { AGENT_LABELS } from '../../cli/shared/labels';
import { DetailDialog } from '../../ui/DetailDialog';
import { buttonClass } from '../../ui/styles';
import { cacheColor, percent, tokens } from './presentation';

function UsageDetail({ row, close }: { row: UsageRow; close(): void }) {
  const fields = [
    ['CLI', AGENT_LABELS[row.agent]],
    ['原生会话', row.sessionId],
    ['子代理', row.childId],
    ['原生响应', row.id],
    ['模型', row.model],
    [
      '型号来源',
      row.modelSource === 'response' ? '原生响应' : row.modelSource === 'configuration' ? '当时配置' : '未记录',
    ],
    ['数据来源', row.source],
    [
      '单价来源',
      row.priceSource === 'official' ? '官方 API 参考价' : row.priceSource === 'custom' ? '自定义单价' : undefined,
    ],
    ['缓存读取', tokens(row.tokens.cacheRead)],
    ['缓存写入', tokens(row.tokens.cacheWrite)],
    ['计价范围', row.costUsd === undefined ? undefined : row.costPartial ? '已计量分项' : '完整分项'],
    ['输出计数', row.outputFinal ? '原生完整记录' : '原生保存值，未确认最终输出量'],
    ['生成时长', row.durationMs === undefined ? undefined : `${(row.durationMs / 1000).toFixed(2)} 秒`],
    ['首段等待', row.firstTokenMs === undefined ? undefined : `${(row.firstTokenMs / 1000).toFixed(2)} 秒`],
  ];
  return (
    <DetailDialog title="用量记录" onClose={close}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm">
        {fields
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-all">{v}</dd>
            </div>
          ))}
      </dl>
    </DetailDialog>
  );
}
export function UsageRecords({
  rows,
  total,
  offset,
  changeOffset,
  projects,
}: {
  projects: Workspace[];
  rows: UsageRow[];
  total: number;
  offset: number;
  changeOffset(value: number): void;
}) {
  const [selected, setSelected] = useState<UsageRow>();
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">生成记录</h2>
        <span className="text-xs text-muted-foreground">{total.toLocaleString()}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              {['时间', 'CLI / 模型', '工作区', '新增输入', '输出', '缓存读取', '命中率', '估价', ''].map(
                (label, i) => (
                  <th key={i} className={`whitespace-nowrap px-4 py-3 font-medium ${i >= 3 ? 'text-right' : ''}`}>
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border/60 hover:bg-control-hover/40">
                <td className="whitespace-nowrap px-4 py-2.5 tabular-nums">
                  {new Date(row.timestamp).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td className="max-w-56 px-4 py-2.5">
                  <p className="truncate" title={row.model}>
                    {row.model ?? '型号未记录'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {row.agent === 'antigravity' ? 'AGY' : AGENT_LABELS[row.agent]}
                    {row.childId ? ' · 子代理' : ''}
                  </p>
                </td>
                <td className="max-w-32 truncate px-4 py-2.5">
                  {projects.find((p) => p.id === row.projectId)?.name ?? '—'}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{tokens(row.tokens.input)}</td>
                <td
                  className="px-4 py-2.5 text-right tabular-nums"
                  title={row.outputFinal ? undefined : '未确认最终输出量，详见记录'}
                >
                  {row.outputFinal ? tokens(row.tokens.output) : '—'}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{tokens(row.tokens.cacheRead)}</td>
                <td className={`whitespace-nowrap px-4 py-2.5 text-right tabular-nums ${cacheColor(row.cacheRate)}`}>
                  {percent(row.cacheRate)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {row.costUsd === undefined ? '—' : `$${row.costUsd.toFixed(4)}`}
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    aria-label="查看记录详情"
                    title="查看记录详情"
                    className={buttonClass('ghost')}
                    onClick={() => setSelected(row)}
                  >
                    <ListTree aria-hidden className="size-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="p-8 text-center text-sm text-muted-foreground">没有符合筛选的记录</p>}
      {total > 0 && (
        <div className="flex items-center justify-end gap-3 border-t border-border p-3">
          <span className="mr-auto text-xs text-muted-foreground">
            显示 {offset + 1}–{Math.min(offset + 100, total)} 条，共 {total.toLocaleString()} 条
          </span>
          <button
            type="button"
            className={buttonClass('ghost')}
            disabled={!offset}
            onClick={() => changeOffset(Math.max(0, offset - 100))}
          >
            上一页
          </button>
          <button
            type="button"
            className={buttonClass('ghost')}
            disabled={offset + 100 >= total}
            onClick={() => changeOffset(offset + 100)}
          >
            下一页
          </button>
        </div>
      )}
      {selected && <UsageDetail row={selected} close={() => setSelected(undefined)} />}
    </section>
  );
}
