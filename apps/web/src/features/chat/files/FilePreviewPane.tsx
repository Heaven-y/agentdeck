import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { WorkspaceFilePreview } from '@agentdeck/shared/projects';
import { request } from '../../../lib/http';
import { queryClient } from '../../../lib/query-client';
import { buttonClass, iconButtonClass } from '../../../ui/styles';
import { CodeEditor, type CodeFormat } from '../../../ui/fields/CodeEditor';
import type { FilePreviewTarget } from './file-preview-store';

const formats: Record<string, CodeFormat> = {
  json: 'json',
  toml: 'toml',
  py: 'python',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'shell',
  bash: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
};
function PreviewContent({ result, line }: { result: WorkspaceFilePreview; line?: number }) {
  if (result.view === 'diff' && !result.content)
    return <p className="p-4 text-sm text-muted-foreground">没有未提交的改动。</p>;
  const format =
    result.view === 'diff' ? 'diff' : (formats[result.path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'text');
  return (
    <CodeEditor
      key={`${result.view}:${line}`}
      value={result.content}
      format={format}
      disabled
      height="100%"
      label={result.view === 'diff' ? '文件改动' : '文件内容'}
      initialLine={result.view === 'content' ? line : undefined}
    />
  );
}

export function FilePreviewPane({ target }: { target: FilePreviewTarget }) {
  const [view, setView] = useState<'content' | 'diff'>('content');
  const preview = useQuery(
    {
      queryKey: ['file-preview', target.workspaceId, target.conversationId, target.path, view],
      queryFn: ({ signal }) => {
        const query = new URLSearchParams({ path: target.path, view });
        return request<WorkspaceFilePreview>(`/api/projects/${encodeURIComponent(target.workspaceId)}/file?${query}`, {
          signal,
        });
      },
      gcTime: 0,
      retry: false,
    },
    queryClient,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {(['content', 'diff'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={view === value}
            onClick={() => setView(value)}
            className={buttonClass(view === value ? 'outline' : 'ghost')}
          >
            {value === 'content' ? '内容' : '改动'}
          </button>
        ))}
        <button
          type="button"
          aria-label="刷新文件"
          disabled={preview.isFetching}
          className={`${iconButtonClass} ml-auto`}
          onClick={() => void preview.refetch()}
        >
          <RefreshCw aria-hidden className="size-3.5" />
        </button>
      </div>
      <p className="shrink-0 break-all border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
        {preview.data?.path ?? target.path}
      </p>
      <div className="min-h-0 flex-1 overflow-hidden">
        {preview.isError ? (
          <p role="alert" className="p-4 text-sm text-destructive-foreground">
            {preview.error.message}
          </p>
        ) : preview.data ? (
          <PreviewContent result={preview.data} line={target.line} />
        ) : (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            正在读取…
          </p>
        )}
      </div>
    </div>
  );
}
