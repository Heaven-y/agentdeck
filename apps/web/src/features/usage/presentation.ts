const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const tokens = (value?: number) => (value === undefined ? '—' : compact.format(value));
export const percent = (value?: number) => (value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
export const cacheColor = (value?: number) => {
  if (value === undefined) return 'text-muted-foreground';
  if (value >= 0.8) return 'text-success';
  return value < 0.5 ? 'text-warning' : 'text-foreground';
};
export const chartColors = ['#709bd5', '#65ad99', '#a391d6', '#c6a46b', '#9aabbf'];
export const tokenParts = [
  { field: 'input', label: '新增输入', color: chartColors[0] },
  { field: 'output', label: '输出', color: chartColors[1] },
  { field: 'cacheRead', label: '缓存读取', color: chartColors[2] },
  { field: 'cacheWrite', label: '缓存写入', color: chartColors[3] },
] as const;
