import { Menu, MenuButton, MenuItem, MenuProvider, MenuSeparator } from '@ariakit/react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../lib/http';
import { MenuChoice, modelMenuItemClass } from '../../ui/MenuChoice';
import { buttonClass } from '../../ui/styles';
import { useChat } from './chat-store';
import { useAgentCapabilities } from './use-agent-capabilities';

const labels = { default: '执行模式', plan: '计划模式' } as const;

function CodexModeMenu({ disabled }: { disabled: boolean }) {
  const [opened, setOpened] = useState(false);
  const [requested, setRequested] = useState(false);
  const mode = useChat((state) => state.collaborationMode);
  const setMode = useChat((state) => state.setCollaborationMode);
  const catalog = useAgentCapabilities(requested || opened, requested || opened);
  const modes = catalog.data?.collaborationModes;
  return (
    <MenuProvider placement="top-end" open={opened} setOpen={setOpened}>
      <MenuButton
        aria-label="协作模式"
        title="选择下一轮的协作模式"
        disabled={disabled}
        onFocus={() => setRequested(true)}
        className={`${buttonClass('ghost')} min-h-7 gap-1 rounded-lg px-2 text-[13px]`}
      >
        <span>{mode ? labels[mode] : '原生模式'}</span>
        <ChevronDown aria-hidden className="size-3 shrink-0" />
      </MenuButton>
      <Menu
        portal
        unmountOnHide
        gutter={8}
        aria-label="协作模式菜单"
        className="z-50 w-64 max-w-[calc(100vw-32px)] rounded-2xl border border-border bg-card p-1 text-foreground shadow-lg"
      >
        <MenuChoice checked={!mode} disabled={disabled} choose={() => setMode(undefined)}>
          原生模式
        </MenuChoice>
        {modes?.map((value) => (
          <MenuChoice key={value} checked={mode === value} disabled={disabled} choose={() => setMode(value)}>
            {labels[value]}
          </MenuChoice>
        ))}
        <ModeCatalogStatus catalog={catalog} />
        <MenuSeparator className="my-1 border-t border-border" />
        <MenuItem
          className={modelMenuItemClass}
          disabled={disabled || catalog.isFetching}
          hideOnClick={false}
          onClick={catalog.refresh}
        >
          <RefreshCw aria-hidden className="size-3.5" />
          刷新协作模式
        </MenuItem>
      </Menu>
    </MenuProvider>
  );
}

function ModeCatalogStatus({ catalog }: { catalog: ReturnType<typeof useAgentCapabilities> }) {
  if (catalog.isFetching)
    return (
      <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
        正在读取协作模式…
      </p>
    );
  if (catalog.isError)
    return (
      <p role="alert" className="px-3 py-2 text-xs leading-5 text-warning">
        {catalog.error instanceof ApiError ? catalog.error.message : '协作模式读取失败，请刷新重试。'}
      </p>
    );
  if (!catalog.data?.collaborationModes?.length)
    return (
      <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">尚未核实可用的协作模式，可刷新原生目录。</p>
    );
  return null;
}

export function CollaborationModeMenu({ disabled = false }: { disabled?: boolean }) {
  const agent = useChat((state) => state.agent);
  if (agent !== 'codex') return null;
  return <CodexModeMenu disabled={disabled} />;
}
