import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { invalidateNativeCapabilities } from '../../../cli/shared/capability-cache';
import { desktopAntigravityLogin } from '../../../lib/desktop-bridge';
import { queryClient } from '../../../lib/query-client';
import { buttonClass } from '../../../ui/styles';
import { antigravityAccountKey, modelSettingsApi } from './model-settings-api';

type LoginStatus = 'idle' | 'pending' | 'completed' | 'not-completed' | 'failed';

function ManualLogin() {
  return (
    <span>
      可在本机终端运行 <code className="font-mono">agy acp --login</code> 完成登录。
    </span>
  );
}

function LoginFeedback({ status }: { status: LoginStatus }) {
  if (status === 'idle') return null;
  if (status === 'failed') {
    return (
      <p role="alert" className="text-xs leading-5 text-destructive-foreground">
        无法打开登录终端。
        <ManualLogin />
      </p>
    );
  }
  const messages = {
    pending: '请在登录终端完成 Google 登录。如果浏览器给出授权码，请粘贴回该终端。',
    completed: '登录命令已正常结束，可以返回会话重试。',
    'not-completed': '登录未完成。可以重新打开终端再试。',
  };
  return (
    <p role="status" className="text-xs leading-5 text-muted-foreground">
      {messages[status]}
    </p>
  );
}

export function AntigravityConnectionActions({ disabled }: { disabled: boolean }) {
  const [status, setStatus] = useState<LoginStatus>('idle');
  const launch = desktopAntigravityLogin();
  const account = useQuery(
    {
      queryKey: antigravityAccountKey,
      queryFn: ({ signal }) => modelSettingsApi.antigravityAccount(signal),
      enabled: status !== 'pending',
      retry: false,
      gcTime: 0,
    },
    queryClient,
  );
  const accountLabel =
    status === 'pending'
      ? '等待登录…'
      : account.isFetching
        ? '正在读取账号…'
        : account.isError
          ? '未能确认当前账号'
          : (account.data?.email ?? '未能确认当前账号');
  const openLogin = async () => {
    if (!launch || status === 'pending') return;
    setStatus('pending');
    void queryClient.cancelQueries({ queryKey: antigravityAccountKey });
    try {
      const completed = await launch();
      setStatus(completed ? 'completed' : 'not-completed');
      if (completed) void invalidateNativeCapabilities('antigravity').catch(() => undefined);
    } catch {
      setStatus('failed');
    } finally {
      void queryClient.invalidateQueries({ queryKey: antigravityAccountKey });
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs text-muted-foreground">Google 账号</p>
          <p role="status" className="break-all text-[13px] font-medium">
            {accountLabel}
          </p>
        </div>
        {launch && (
          <button
            type="button"
            className={buttonClass('outline')}
            disabled={disabled || status === 'pending'}
            onClick={() => void openLogin()}
          >
            <LogIn aria-hidden className="size-3.5" />
            重新登录 Antigravity
          </button>
        )}
      </div>
      {launch ? (
        <LoginFeedback status={status} />
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          <ManualLogin />
        </p>
      )}
    </div>
  );
}
