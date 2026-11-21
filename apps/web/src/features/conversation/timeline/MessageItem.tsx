import { Brain, Check, ChevronRight, CircleAlert, Copy, X } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { Streamdown } from 'streamdown';
import type { ChatItem } from '../model/conversation-events';
import { MessageAttachments } from './MessageAttachments';
import { ToolCard } from './ToolCard';
import { CompactionStatus } from '../context/ContextPresentation';
import type { ExpandedProps } from './timeline-model';
import { StatisticsLine } from './StatisticsLine';
import { ActivityCard } from './ActivityCard';
import {
  SessionReferenceText,
  sessionMarkdownComponents,
  sessionMarkdownUrl,
} from '../references/SessionReferenceText';
import { sessionRemarkPlugins } from '../references/session-reference-markdown';
import { isConversationControl, useConversationSurface, type ConversationError } from '../ConversationSurface';
import { ConversationControlView } from './ConversationControlView';

function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  if (!text.trim() || !navigator.clipboard?.writeText) return null;
  return (
    <button
      type="button"
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : label}
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 hover:bg-control-hover hover:text-foreground focus-visible:opacity-100"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => {},
        );
      }}
    >
      {copied ? <Check aria-hidden className="size-3 text-success" /> : <Copy aria-hidden className="size-3" />}
      <span>{copied ? '已复制' : '复制'}</span>
    </button>
  );
}

function ErrorMessage({ item }: { item: ConversationError }) {
  const { dismissError, isErrorDismissed } = useConversationSurface();
  if (isErrorDismissed?.(item)) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-border-danger bg-surface-danger px-3.5 py-2.5 text-[13px] leading-6"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 break-words text-destructive-foreground">{item.message}</span>
      {dismissError && (
        <button
          type="button"
          aria-label="关闭这条错误"
          title="关闭"
          className="-m-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-control-hover hover:text-foreground"
          onClick={() => dismissError(item)}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function AssistantMessage({ item }: { item: Extract<ChatItem, { kind: 'assistant' }> }) {
  return (
    <div className="conversation-assistant group/msg">
      <Streamdown
        mode={item.streaming ? 'streaming' : 'static'}
        isAnimating={item.streaming}
        urlTransform={sessionMarkdownUrl}
        components={sessionMarkdownComponents}
        remarkPlugins={sessionRemarkPlugins}
      >
        {item.text}
      </Streamdown>
      {(item.responseModel || (!item.streaming && item.text.trim())) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {item.responseModel && (
            <p className="text-xs leading-5 break-all text-muted-foreground">响应模型：{item.responseModel}</p>
          )}
          {!item.streaming && <CopyTextButton text={item.text} label="复制回复内容" />}
        </div>
      )}
    </div>
  );
}

function MetadataMessage({ item }: { item: Extract<ChatItem, { kind: 'statistics' | 'compaction' | 'turn-status' }> }) {
  if (item.kind === 'turn-status')
    return (
      <p role="status" className="text-sm leading-6 text-muted-foreground">
        CLI 返回的完成状态与本轮记录不一致，暂时无法确认是否完整完成。
      </p>
    );
  if (item.kind === 'statistics') return <StatisticsLine statistics={item} />;
  return <CompactionStatus state={item.state} incomplete={item.incomplete} />;
}

/** 单个对话条目；memo 避免流式更新时整列表重渲染（条目内容不变时引用不变） */
export const MessageItem = memo(function MessageItem({
  item,
  expanded,
  onExpandedChange,
}: { item: ChatItem } & ExpandedProps) {
  if (isConversationControl(item)) return <ConversationControlView item={item} />;
  switch (item.kind) {
    case 'user':
      return (
        <div className="group/msg flex flex-col items-end gap-1">
          <div className="conversation-user">
            <SessionReferenceText text={item.text} />
            <MessageAttachments attachments={item.attachments} />
          </div>
          <CopyTextButton text={item.text} label="复制消息内容" />
        </div>
      );
    case 'assistant':
      return <AssistantMessage item={item} />;
    case 'reasoning':
      return (
        <details
          className="tool-card group/reasoning min-w-0 text-[13px] text-muted-foreground"
          open={expanded}
          onToggle={(event) => {
            if (event.currentTarget.open !== expanded) onExpandedChange?.(event.currentTarget.open);
          }}
        >
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1 marker:hidden transition-colors select-none hover:bg-control-hover/50 hover:text-foreground">
            <Brain aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 font-medium">思考过程</span>
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/reasoning:rotate-90"
            />
          </summary>
          <div className="mt-1 mr-2 mb-2 ml-3.5 border-l border-border py-1 pl-4">
            <p className="leading-6 whitespace-pre-wrap break-words">{item.text}</p>
          </div>
        </details>
      );
    case 'tool':
      return <ToolCard item={item} expanded={expanded} onExpandedChange={onExpandedChange} />;
    case 'activity':
      return <ActivityCard item={item} expanded={expanded} onExpandedChange={onExpandedChange} />;
    case 'error':
      return <ErrorMessage item={item} />;
    default:
      return <MetadataMessage item={item} />;
  }
});
