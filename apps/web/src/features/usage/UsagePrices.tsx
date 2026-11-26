import { useState } from 'react';
import type { OfficialUsagePrice, UsagePrice, UsageRecord } from '@agentdeck/shared/usage';
import { AGENT_KINDS } from '@agentdeck/shared/conversation';
import { AGENT_LABELS } from '../../cli/shared/labels';
import { DetailDialog } from '../../ui/DetailDialog';
import { buttonClass, inputClass } from '../../ui/styles';
import { request } from '../../lib/http';

export function UsagePrices({
  prices,
  models,
  officialPrices,
  close,
  saved,
}: {
  prices: UsagePrice[];
  models: string[];
  officialPrices: OfficialUsagePrice[];
  close(): void;
  saved(): void;
}) {
  const [rows, setRows] = useState(prices),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const add = () =>
    setRows([
      ...rows,
      { agent: 'antigravity', model: models[0] ?? '', provider: '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
  function update(index: number, patch: Partial<UsagePrice>) {
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      await request('/api/usage/prices', { method: 'PUT', body: JSON.stringify({ prices: rows }) });
      saved();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : '单价保存失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <DetailDialog title="模型单价" onClose={close} busy={busy}>
      <div className="space-y-4">
        <OfficialPrices prices={officialPrices} />
        <h3 className="border-t border-border pt-4 text-sm font-medium">自定义覆盖</h3>
        <p className="text-xs text-muted-foreground">按 CLI、模型和供应方匹配；移除后恢复官方参考价。</p>
        <datalist id="usage-models">
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        {rows.map((row, index) => (
          <div key={index} className="space-y-2 rounded-lg border border-border p-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs">
                CLI
                <select
                  className={`${inputClass} mt-1 w-full`}
                  value={row.agent}
                  onChange={(e) => update(index, { agent: e.target.value as UsageRecord['agent'] })}
                >
                  {AGENT_KINDS.map((agent) => (
                    <option key={agent} value={agent}>
                      {AGENT_LABELS[agent]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                模型
                <input
                  className={`${inputClass} mt-1 w-full`}
                  list="usage-models"
                  value={row.model}
                  onChange={(e) => update(index, { model: e.target.value })}
                />
              </label>
            </div>
            <label className="block text-xs">
              供应方（未记录时留空）
              <input
                className={`${inputClass} mt-1 w-full`}
                value={row.provider}
                onChange={(e) => update(index, { provider: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((field, i) => (
                <label key={field} className="text-xs">
                  {['新增输入', '输出', '缓存读取', '缓存写入'][i]}
                  <input
                    type="number"
                    min="0"
                    step="any"
                    className={`${inputClass} mt-1 w-full`}
                    value={row[field]}
                    onChange={(e) => update(index, { [field]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              className={buttonClass('ghost')}
              onClick={() => setRows(rows.filter((_, i) => i !== index))}
            >
              移除此单价
            </button>
          </div>
        ))}
        {error && (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        )}
        <div className="flex justify-between">
          <button type="button" className={buttonClass('outline')} onClick={add}>
            添加单价
          </button>
          <button type="button" className={buttonClass('primary')} disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </DetailDialog>
  );
}

function OfficialPrices({ prices }: { prices: OfficialUsagePrice[] }) {
  const [search, setSearch] = useState('');
  const day = new Date().toISOString().slice(0, 10);
  const current = prices.filter(
    (p) =>
      (!p.effectiveFrom || p.effectiveFrom <= day) &&
      (!p.effectiveTo || p.effectiveTo > day) &&
      p.model.includes(search.trim().toLowerCase()),
  );
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">官方 API 参考价</h3>
        <span className="text-xs text-muted-foreground">更新于 {prices[0]?.verifiedAt}</span>
      </div>
      <p className="text-xs text-muted-foreground">自动匹配模型，单位：美元 / 百万 Tokens。</p>
      <input
        type="search"
        aria-label="搜索官方单价"
        placeholder="搜索模型"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className={inputClass}
      />
      <div className="max-h-64 overflow-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
            <tr>
              {['模型', '输入', '输出', '缓存读取'].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {current.map((p) => (
              <tr key={p.model} className="border-t border-border/60">
                <td className="px-3 py-2">
                  <a
                    className="text-interactive hover:underline"
                    href={p.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="查看官网价格"
                  >
                    {p.model}
                  </a>
                  {p.longContext && (
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">长上下文自动分档</span>
                  )}
                  <PriceConditions price={p} />
                </td>
                {[p.input, p.output, p.cacheRead].map((rate, i) => (
                  <td key={i} className="px-3 py-2 text-right tabular-nums">
                    {rate ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!current.length && <p className="p-4 text-center text-xs text-muted-foreground">没有匹配的官方型号</p>}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">计价规则</summary>
        <p className="mt-2 leading-5">
          使用官网标准文本 API
          参考价，长上下文按实际输入量分档。缓存写入按已记录的时长类型计价；未知分项不计入估价。订阅账单与缓存存储费不在此表中。
        </p>
      </details>
    </section>
  );
}

function PriceConditions({ price }: { price: OfficialUsagePrice }) {
  const fieldNames: Record<string, string> = {
    input: '输入',
    output: '输出',
    cacheRead: '缓存读取',
    cacheWrite: '缓存写入',
  };
  return (
    <details className="mt-1 text-[10px] text-muted-foreground">
      <summary className="cursor-pointer">分档与缓存写入</summary>
      <div className="mt-1 space-y-1 leading-4">
        {price.writeRates &&
          Object.entries(price.writeRates).map(([ttl, rate]) => (
            <p key={ttl}>
              写入 {ttl}：${rate}
            </p>
          ))}
        {price.writeMode === 'input' && <p>写入按普通输入价计算</p>}
        {price.writeMode === 'none' && <p>隐式缓存，无独立写入费</p>}
        {price.writeMode === 'storage' && <p>显式缓存存储按时长另计</p>}
        {price.longContext && (
          <p>
            总输入超过 {price.longContext.above.toLocaleString()}：
            {Object.entries(price.longContext.multipliers)
              .map(([field, rate]) => `${fieldNames[field]} ×${rate}`)
              .join('，')}
          </p>
        )}
        {price.effectiveFrom && <p>生效日期：{price.effectiveFrom}</p>}
        {price.effectiveTo && <p>有效至：{price.effectiveTo} 前</p>}
      </div>
    </details>
  );
}
