import { CircleAlert, X } from 'lucide-react';
import { memo } from 'react';
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

function ErrorMessage({ item }: { item: ConversationError }) {
  const { dismissError, isErrorDismissed } = useConversationSurface();
  if (isErrorDismissed?.(item)) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl bg-destructive/8 px-3 py-2 text-[13px] leading-6">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 break-words text-destructive-foreground">{item.message}</span>
      {dismissError && (
        <button
          type="button"
          aria-label="关闭这条错误"
          title="关闭"
          className="-m-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
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
    <div className="conversation-assistant">
      <Streamdown
        mode={item.streaming ? 'streaming' : 'static'}
        isAnimating={item.streaming}
        urlTransform={sessionMarkdownUrl}
        components={sessionMarkdownComponents}
        remarkPlugins={sessionRemarkPlugins}
      >
        {item.text}
      </Streamdown>
      {item.responseModel && (
        <p className="mt-2 text-xs leading-5 break-all text-muted-foreground">响应模型：{item.responseModel}</p>
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
        <div className="conversation-user">
          <SessionReferenceText text={item.text} />
          <MessageAttachments attachments={item.attachments} />
        </div>
      );
    case 'assistant':
      return <AssistantMessage item={item} />;
    case 'reasoning':
      return (
        <details
          className="min-w-0 text-[13px] text-muted-foreground"
          open={expanded}
          onToggle={(event) => {
            if (event.currentTarget.open !== expanded) onExpandedChange?.(event.currentTarget.open);
          }}
        >
          <summary className="w-fit cursor-pointer rounded-lg py-1 leading-6 select-none hover:text-foreground">
            思考过程
          </summary>
          <p className="mt-1 border-l border-border pl-4 leading-6 whitespace-pre-wrap break-words">{item.text}</p>
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
