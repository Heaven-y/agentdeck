import { useState } from 'react';
import type { NativePluginCatalog, NativePluginPrepareInput } from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../../ui/styles';
import { confirmNativeDiscard } from '../resources/native-resource-labels';
import { useSettingsLeave } from '../navigation/settings-navigation';
export function NativePluginInstall({
  catalog,
  busy,
  onPrepare,
}: {
  catalog: NativePluginCatalog;
  busy: boolean;
  onPrepare(input: NativePluginPrepareInput): void;
}) {
  const [source, setSource] = useState('');
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const [market, setMarket] = useState(false);
  const dirty = source !== '' || market || scope !== 'user';
  useSettingsLeave((action) => {
    if (confirmNativeDiscard(dirty)) action();
  }, dirty);
  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onPrepare({
          action: market ? 'marketplace-add' : 'install',
          source: source.trim(),
          scope,
          revision: catalog.revision,
        });
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <strong className="text-sm">添加插件或市场</strong>
        {catalog.canAddMarketplace && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={market} onChange={(event) => setMarket(event.target.checked)} />
            添加市场来源
          </label>
        )}
      </div>
      <label className="block space-y-1 text-sm">
        <span>{market ? '市场来源' : '安装来源'}</span>
        <input
          className={inputClass}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder={
            market
              ? 'owner/repo、HTTPS 地址或本地目录'
              : catalog.agent === 'antigravity'
                ? '官方插件名、GitHub 地址或本地目录'
                : 'plugin@marketplace'
          }
          required
          autoComplete="off"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="shrink-0 whitespace-nowrap">安装范围</span>
          <select
            aria-label="安装范围"
            className={inputClass}
            value={scope}
            onChange={(event) => setScope(event.target.value as typeof scope)}
          >
            {catalog.installScopes.map((item) => (
              <option key={item} value={item}>
                {item === 'user' ? '用户' : item === 'project' ? '项目' : '个人项目'}
              </option>
            ))}
          </select>
        </label>
        <button className={buttonClass('primary')} type="submit" disabled={busy || !catalog.installScopes.length}>
          预览操作
        </button>
      </div>
    </form>
  );
}
