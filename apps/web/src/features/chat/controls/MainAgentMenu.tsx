import { Menu, MenuButton, MenuProvider, MenuItem } from '@ariakit/react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AntigravityMainAgents } from '@agentdeck/shared/conversation';
import { queryClient } from '../../../lib/query-client';
import { request } from '../../../lib/http';
import { buttonClass, popoverClass, menuItemClass } from '../../../ui/styles';
import { managementPending, sessionActionKey, useChat } from '../state/chat-store';
import { forkSession } from '../../sessions/actions/session-fork';

function useAgentMenu() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const workspaceId = useChat((state) => state.workspaceId);
  const sessionId = useChat((state) => state.sessionId);
  const conversationId = useChat((state) => state.conversationId);
  const chosen = useChat((state) => state.mainAgent);
  const running = useChat((state) => state.running || !!state.pendingClientTurnId || managementPending(state));
  const operation = useChat((state) =>
    workspaceId && sessionId
      ? state.sessionOperations[sessionActionKey(workspaceId, { agent: 'antigravity', sessionId })]
      : undefined,
  );
  const catalog = useQuery(
    {
      queryKey: ['antigravity-main-agents', workspaceId, sessionId],
      enabled: open && !!workspaceId,
      queryFn: ({ signal }) =>
        request<AntigravityMainAgents>(
          `/api/workspaces/${encodeURIComponent(workspaceId!)}/antigravity-agents${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
          { signal },
        ),
      retry: false,
    },
    queryClient,
  );
  const current = sessionId ? catalog.data?.current : (chosen ?? '');
  const unavailable = busy || (!!sessionId && !catalog.data);
  const choose = async (name: string) => {
    if (busy || running || !workspaceId) return;
    if (!sessionId) {
      useChat.getState().touchDraft();
      useChat.setState({ mainAgent: name || undefined });
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      if (await forkSession(workspaceId, { agent: 'antigravity', sessionId }, { mainAgent: name })) setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return { open, setOpen, busy, sessionId, conversationId, catalog, current, unavailable, choose, operation, running };
}

function AntigravityAgentMenu({ disabled }: { disabled: boolean }) {
  const { open, setOpen, busy, sessionId, conversationId, catalog, current, unavailable, choose, operation, running } =
    useAgentMenu();
  return (
    <MenuProvider key={conversationId} placement="top-start" open={open} setOpen={setOpen}>
      <MenuButton
        aria-label="主代理"
        disabled={disabled || running || busy}
        className={`${buttonClass('ghost')} min-h-7 max-w-40 gap-1 px-2`}
      >
        <span className="truncate">{current || '主代理'}</span>
        <ChevronDown aria-hidden className="size-3" />
      </MenuButton>
      <Menu
        portal
        unmountOnHide
        gutter={8}
        aria-label="主代理菜单"
        className={`${popoverClass} max-h-80 w-72 overflow-y-auto`}
      >
        {sessionId && <p className="px-3 py-2 text-xs text-muted-foreground">选择代理后创建会话分支</p>}
        <MenuItem
          className={menuItemClass}
          disabled={unavailable || current === ''}
          hideOnClick={false}
          onClick={() => void choose('')}
        >
          默认代理
        </MenuItem>
        {catalog.data?.entries.map((entry) => (
          <MenuItem
            key={entry.name}
            className={`${menuItemClass} flex-col items-start gap-0.5`}
            disabled={unavailable || entry.name === current}
            hideOnClick={false}
            onClick={() => void choose(entry.name)}
          >
            <span>{entry.name}</span>
            {entry.description && (
              <span className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</span>
            )}
          </MenuItem>
        ))}
        <CatalogFeedback
          loading={catalog.isFetching}
          error={catalog.error?.message}
          operationError={operation?.error}
        />
        <MenuItem
          className={menuItemClass}
          disabled={catalog.isFetching || busy}
          hideOnClick={false}
          onClick={() => void catalog.refetch()}
        >
          <RefreshCw aria-hidden className="size-3.5" />
          刷新代理
        </MenuItem>
      </Menu>
    </MenuProvider>
  );
}

function CatalogFeedback({
  loading,
  error,
  operationError,
}: {
  loading: boolean;
  error?: string;
  operationError?: string;
}) {
  return (
    <>
      {loading && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          正在读取…
        </p>
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      {operationError && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive-foreground">
          {operationError}
        </p>
      )}
    </>
  );
}

export function MainAgentMenu({ disabled = false }: { disabled?: boolean }) {
  const agent = useChat((state) => state.agent);
  const conversationId = useChat((state) => state.conversationId);
  return agent === 'antigravity' ? <AntigravityAgentMenu key={conversationId} disabled={disabled} /> : null;
}
