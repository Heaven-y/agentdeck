import { useEffect, useState } from 'react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { ClaudeAutoMemoryState } from '@agentdeck/shared/settings';
import { ChevronRight, FileCode2, RefreshCw } from 'lucide-react';
import { settingsApi } from '../api';
import { buttonClass } from '../../../ui/styles';

type Override = 'inherit' | 'enabled' | 'disabled';

export function NativeMemorySettings({ agent, onOpenFiles }: { agent: AgentKind; onOpenFiles(): void }) {
  if (agent !== 'claude') return <ExternalMemorySettings agent={agent} onOpenFiles={onOpenFiles} />;
  return <ClaudeAutoMemorySettings />;
}

function useClaudeAutoMemory() {
  const [memory, setMemory] = useState<ClaudeAutoMemoryState>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void settingsApi
      .readClaudeAutoMemory(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setMemory(result);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取记忆设置。');
      });
    return () => controller.abort();
  }, [reload]);

  const save = async (override: Override) => {
    if (saving || !memory) return;
    setSaving(true);
    setError('');
    try {
      setMemory(await settingsApi.saveClaudeAutoMemory(override));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存记忆设置。');
    } finally {
      setSaving(false);
    }
  };

  return {
    memory,
    error,
    loading: !memory && !error,
    saving,
    save,
    refresh() {
      if (saving) return;
      setMemory(undefined);
      setError('');
      setReload((value) => value + 1);
    },
  };
}

function ExternalMemorySettings({ agent, onOpenFiles }: { agent: AgentKind; onOpenFiles(): void }) {
  return (
    <section className="max-w-3xl space-y-5">
      <div className="space-y-2 border-b border-border pb-5">
        <h2 className="text-base font-semibold">{agent === 'codex' ? 'Codex 持久上下文' : 'Antigravity 持久上下文'}</h2>
        <p className="text-sm leading-6 text-muted-foreground">在规则和指令文件中保存项目约定，供后续对话使用。</p>
      </div>
      <button type="button" className={buttonClass('outline')} onClick={onOpenFiles}>
        <FileCode2 aria-hidden className="size-4" />
        管理规则与指令
      </button>
    </section>
  );
}

function ClaudeAutoMemorySettings() {
  const state = useClaudeAutoMemory();
  return (
    <section className="max-w-3xl space-y-5">
      <div className="space-y-2 border-b border-border pb-5">
        <h2 className="text-base font-semibold">Claude Code 自动记忆</h2>
        <p className="text-sm leading-6 text-muted-foreground">在 Claude Code 中使用 /memory 查看和整理记忆。</p>
        <details className="group/scope text-xs leading-6 text-muted-foreground">
          <summary className="inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded-md py-0.5 marker:hidden transition-colors select-none hover:text-foreground">
            <ChevronRight aria-hidden className="size-3.5 transition-transform group-open/scope:rotate-90" />
            版本与生效范围
          </summary>
          <div className="mt-1 space-y-1 pl-4">
            <p>需要 Claude Code 2.1.234 或更新版本。记忆按 Git 仓库保存在本机，此处设置适用于所有项目。</p>
            <p>项目设置、环境变量或管理员策略可覆盖全局设置。</p>
          </div>
        </details>
      </div>
      <MemoryStatus memory={state.memory} error={state.error} />
      <MemoryControls {...state} />
    </section>
  );
}

function MemoryStatus({ memory, error }: Pick<ReturnType<typeof useClaudeAutoMemory>, 'memory' | 'error'>) {
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive-foreground">
        {error}
      </p>
    );
  if (!memory)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        正在读取记忆设置…
      </p>
    );
  return null;
}

function MemoryControls({
  memory,
  saving,
  loading,
  save,
  refresh,
}: Pick<ReturnType<typeof useClaudeAutoMemory>, 'memory' | 'saving' | 'loading' | 'save' | 'refresh'>) {
  return (
    <>
      {memory && <UserMemoryControl memory={memory} saving={saving} save={save} />}
      <div className="flex items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {saving ? '正在保存…' : ''}
        </p>
        <button type="button" className={buttonClass('ghost')} disabled={saving || loading} onClick={refresh}>
          <RefreshCw aria-hidden className="size-4" />
          重新读取
        </button>
      </div>
    </>
  );
}

function UserMemoryControl({
  memory,
  saving,
  save,
}: Pick<ReturnType<typeof useClaudeAutoMemory>, 'memory' | 'saving' | 'save'> & {
  memory: ClaudeAutoMemoryState;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">全局自动记忆</h3>
        <p className="text-sm text-muted-foreground">
          {memory.override === null ? '已启用（默认）' : memory.enabled ? '已启用' : '已关闭'}
        </p>
      </div>
      <label className="flex cursor-pointer items-center gap-2.5 text-[13px] font-medium">
        <input
          type="checkbox"
          aria-label="启用自动记忆"
          className="ui-switch-checkbox"
          checked={memory.enabled}
          disabled={saving}
          onChange={(event) => void save(event.currentTarget.checked ? 'enabled' : 'disabled')}
        />
        启用自动记忆
      </label>
    </div>
  );
}
