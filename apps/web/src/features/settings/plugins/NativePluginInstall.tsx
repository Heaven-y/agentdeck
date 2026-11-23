import { useState } from 'react';
import type { NativePluginCatalog, NativePluginPrepareInput } from '@agentdeck/shared/settings';
import { buttonClass, inputClass } from '../../../ui/styles';
import { confirmNativeDiscard, nativeScopeNames } from '../resources/native-resource-labels';
import { useSettingsLeave } from '../navigation/settings-navigation';
import { ResourceDetails } from '../resources/ResourceList';

export function NativePluginInstall({
  catalog,
  busy,
  onPrepare,
  onBack,
}: {
  catalog: NativePluginCatalog;
  busy: boolean;
  onPrepare(input: NativePluginPrepareInput): void;
  onBack(): void;
}) {
  const [source, setSource] = useState('');
  const [selectedScope, setScope] = useState<NativePluginCatalog['installScopes'][number]>();
  const [addMarketplace, setMarket] = useState(false);
  const scope = catalog.installScopes.find((value) => value === selectedScope) ?? catalog.installScopes[0];
  const market = catalog.canAddMarketplace && (addMarketplace || !catalog.canInstall);
  const dirty = source !== '';
  const leave = (action: () => void) => {
    if (confirmNativeDiscard(dirty)) action();
  };
  useSettingsLeave(leave, dirty);
  if (!scope) return null;
  return (
    <ResourceDetails title={catalog.canInstall ? '添加插件' : '添加市场来源'} onBack={() => leave(onBack)}>
      <form
        className="max-w-xl space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!source.trim() || busy) return;
          onPrepare({
            action: market ? 'marketplace-add' : 'install',
            source: source.trim(),
            scope,
            revision: catalog.revision,
          });
        }}
      >
        <InstallSource catalog={catalog} market={market} source={source} setMarket={setMarket} setSource={setSource} />
        <div className="flex flex-wrap items-center gap-2">
          {catalog.installScopes.length > 1 && (
            <label className="flex items-center gap-2 text-sm">
              安装范围
              <select
                aria-label="安装范围"
                className={inputClass}
                value={scope}
                onChange={(event) => setScope(event.target.value as typeof scope)}
              >
                {catalog.installScopes.map((value) => (
                  <option key={value} value={value}>
                    {nativeScopeNames[value]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className={buttonClass('primary')} type="submit" disabled={busy}>
            预览操作
          </button>
        </div>
      </form>
    </ResourceDetails>
  );
}

function InstallSource({
  catalog,
  market,
  source,
  setMarket,
  setSource,
}: {
  catalog: NativePluginCatalog;
  market: boolean;
  source: string;
  setMarket(value: boolean): void;
  setSource(value: string): void;
}) {
  return (
    <>
      {catalog.canInstall && catalog.canAddMarketplace && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={market} onChange={(event) => setMarket(event.target.checked)} />
          添加市场来源
        </label>
      )}
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
    </>
  );
}
