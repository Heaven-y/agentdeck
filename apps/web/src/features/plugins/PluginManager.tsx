import { useRef, useState } from 'react';
import { Menu, MenuButton, MenuItem, MenuProvider } from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkbenchPlugin, WorkbenchPluginCatalog } from '@agentdeck/shared/plugins';
import { DetailDialog, dialogPortal } from '../../ui/DetailDialog';
import { buttonClass, inputClass, menuItemClass, popoverClass } from '../../ui/styles';
import { pluginApi, pluginsKey } from './plugin-api';
import { useWorkbenchPlugins } from './use-workbench-plugins';

const permissions = {
  storage: '插件自己的本机设置',
  'project-context': '当前项目名称和目录',
  backend: '运行本机服务，访问本机文件和网络',
  clipboard: '读取与写入剪贴板',
  projects: '已添加项目的名称和目录',
  'session-history': '原生会话列表和历史',
  'session-context': '当前会话信息和轮次事件',
  composer: '读取和编辑输入框草稿',
  'session-control': '续接打开的会话和清理关联任务',
};

function PluginCommands({ plugin, run }: { plugin: WorkbenchPlugin; run(command: string): void }) {
  if (!plugin.enabled || !plugin.manifest.commands.length) return null;
  return (
    <MenuProvider placement="bottom-start">
      <MenuButton className={buttonClass('outline')}>操作</MenuButton>
      <Menu
        portal
        portalElement={dialogPortal}
        fixed
        unmountOnHide
        gutter={6}
        hideOnEscape={(event) => {
          event.preventDefault();
          return true;
        }}
        aria-label={`${plugin.manifest.name}操作`}
        className={popoverClass}
      >
        {plugin.manifest.commands.map((command) => (
          <MenuItem key={command.id} className={menuItemClass} onClick={() => run(command.id)}>
            {command.title}
          </MenuItem>
        ))}
      </Menu>
    </MenuProvider>
  );
}

function PluginEntry({
  plugin,
  busy,
  toggle,
  remove,
  run,
}: {
  plugin: WorkbenchPlugin;
  busy: boolean;
  toggle(): void;
  remove(): void;
  run?(command: string): void;
}) {
  return (
    <li className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{plugin.manifest.name}</h3>
        <span className="text-xs text-muted-foreground">
          {plugin.manifest.version} · {plugin.enabled ? '已启用' : '已停用'}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{plugin.manifest.description}</p>
      <p className="text-xs text-muted-foreground">
        可访问：{plugin.manifest.permissions.map((item) => permissions[item]).join('、') || '仅插件页面'}
      </p>
      <div className="flex gap-2">
        {run && <PluginCommands plugin={plugin} run={run} />}
        <button type="button" className={buttonClass('outline')} disabled={busy} onClick={toggle}>
          {plugin.enabled ? `停用 ${plugin.manifest.name}` : `启用 ${plugin.manifest.name}`}
        </button>
        {
          <button type="button" className={buttonClass('danger')} disabled={busy} onClick={remove}>
            卸载 {plugin.manifest.name}
          </button>
        }
      </div>
    </li>
  );
}

export default function PluginManager({
  onClose,
  run,
}: {
  onClose(): void;
  run?(pluginId: string, command: string): boolean;
}) {
  const query = useWorkbenchPlugins();
  const client = useQueryClient();
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const perform = async (action: () => Promise<WorkbenchPluginCatalog>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await client.cancelQueries({ queryKey: pluginsKey });
      client.setQueryData(pluginsKey, await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '插件操作失败，请重新读取');
      await client.invalidateQueries({ queryKey: pluginsKey });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const toggle = (plugin: WorkbenchPlugin) => {
    if (!query.data) return;
    const text = plugin.enabled
      ? `停用“${plugin.manifest.name}”会关闭它的页面与运行服务，插件数据保留。继续吗？`
      : `启用“${plugin.manifest.name}”，允许访问：${plugin.manifest.permissions.map((item) => permissions[item]).join('、') || '仅插件页面'}？`;
    if (window.confirm(text))
      void perform(() => pluginApi.setEnabled(plugin.manifest.id, !plugin.enabled, query.data.revision));
  };
  const remove = (plugin: WorkbenchPlugin) => {
    if (
      query.data &&
      window.confirm(
        `卸载“${plugin.manifest.name}”？${plugin.manifest.apiVersion === 2 ? '插件程序将被移除，数据保留。' : '插件副本与设置将被清理。'}`,
      )
    )
      void perform(() => pluginApi.remove(plugin.manifest.id, query.data.revision));
  };
  return (
    <DetailDialog title="工作台插件" busy={busy} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">安装 AgentDeck 插件，为工作台添加工具页面。</p>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (directory.trim()) void perform(() => pluginApi.install(directory.trim(), query.data?.revision));
          }}
        >
          <label className="block space-y-2 text-sm">
            本地插件目录
            <input
              className={inputClass}
              value={directory}
              disabled={busy}
              placeholder="包含 agentdeck.plugin.json 的目录"
              onChange={(event) => setDirectory(event.target.value)}
            />
          </label>
          <button type="submit" className={buttonClass('primary')} disabled={busy || !directory.trim()}>
            安装或更新插件
          </button>
          <p className="text-xs text-muted-foreground">安装后，选择“启用”开始使用。</p>
        </form>
        {(error || query.error) && (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error || query.error?.message}
          </p>
        )}
        {query.isPending ? (
          <p role="status">正在读取插件…</p>
        ) : (
          <ul className="space-y-3">
            {query.data?.plugins.map((plugin) => (
              <PluginEntry
                key={plugin.manifest.id}
                plugin={plugin}
                busy={busy}
                toggle={() => toggle(plugin)}
                remove={() => remove(plugin)}
                run={
                  run
                    ? (command) => {
                        if (run(plugin.manifest.id, command)) onClose();
                        else setError('未能执行这个操作，请稍后重试。');
                      }
                    : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>
    </DetailDialog>
  );
}
