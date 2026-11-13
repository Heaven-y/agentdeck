import { useEffect, useState } from 'react';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { ClaudeAutoMemoryState } from '@agentdeck/shared/settings';
import { FileCode2, RefreshCw } from 'lucide-react';
import { settingsApi } from './api';
import { buttonClass } from '../../ui/styles';

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
    if (saving) return;
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
    saving,
    save,
    refresh() {
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
        <p className="text-sm leading-6 text-muted-foreground">
          AgentDeck 当前没有确认可独立控制的自动记忆开关。已发现的原生规则和指令文件可在原生文件中管理。
        </p>
      </div>
      <button type="button" className={buttonClass('outline')} onClick={onOpenFiles}>
        <FileCode2 aria-hidden className="size-4" />
        打开原生文件
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
        <p className="text-sm leading-6 text-muted-foreground">
          自动记忆默认开启，内容按 Git 仓库保存在本机。查看或整理记忆内容请使用 Claude Code 的
          /memory；此页只修改全局启用设置，不读取记忆正文。
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          需要 Claude Code 2.1.234 或更新版本。项目级启用或关闭由各项目原生设置管理；环境变量或管理员策略也可能覆盖此配置。
        </p>
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
  save,
  refresh,
}: Pick<ReturnType<typeof useClaudeAutoMemory>, 'memory' | 'saving' | 'save' | 'refresh'>) {
  if (!memory) return null;
  return (
    <>
      <UserMemoryControl memory={memory} saving={saving} save={save} />
      <div className="flex items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {saving ? '正在保存…' : '更改直接写入 Claude 原生设置。'}
        </p>
        <button type="button" className={buttonClass('ghost')} disabled={saving} onClick={refresh}>
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
        <h3 className="text-sm font-medium">用户自动记忆</h3>
        <p className="text-sm text-muted-foreground">
          {memory.override === null
            ? '用户设置未显式指定，当前按 Claude 默认值开启。'
            : `用户设置已显式${memory.enabled ? '启用' : '关闭'}。`}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="启用自动记忆"
          checked={memory.enabled}
          disabled={saving}
          onChange={(event) => void save(event.currentTarget.checked ? 'enabled' : 'disabled')}
        />
        启用自动记忆
      </label>
    </div>
  );
}
