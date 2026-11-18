import { CircleAlert, X } from 'lucide-react';
import { memo, useState } from 'react';
import { Streamdown } from 'streamdown';
import type { ChatItem } from '../../chat/state/chat-reducer';
import { useChat } from '../../chat/state/chat-store';
import { PermissionCard } from '../../chat/interactions/PermissionCard';
import { InteractionCard } from '../../chat/interactions/InteractionCard';
import { MessageAttachments } from './MessageAttachments';
import { ToolCard } from './ToolCard';
import { CompactionStatus } from '../../chat/models/ContextStatus';
import type { ExpandedProps } from './timeline-model';
import { SessionForkPoint } from '../../chat/references/SessionForkPoint';
import { StatisticsLine } from './StatisticsLine';
import { ActivityCard } from './ActivityCard';
import {
  SessionReferenceText,
  sessionMarkdownComponents,
  sessionMarkdownUrl,
} from '../../chat/references/SessionReferenceText';
import { sessionRemarkPlugins } from '../../chat/references/session-reference-markdown';
import { AsyncQuestionCard } from '../../chat/interactions/AsyncQuestionCard';

type ErrorItem = Extract<ChatItem, { kind: 'error' }>;
// 独立只读历史不属于 chat store；弱引用使关闭状态随条目回收，并跨虚拟列表重挂载保留。
const dismissedReadOnlyErrors = new WeakSet<ErrorItem>();

function ErrorMessage({ item }: { item: ErrorItem }) {
  const owner = useChat((state) => (state.items.includes(item) ? state.conversationId : undefined));
  const [, setDismissed] = useState<ErrorItem>();
  if (owner === undefined && dismissedReadOnlyErrors.has(item)) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl bg-destructive/8 px-3 py-2 text-[13px] leading-6">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 break-words text-destructive-foreground">{item.message}</span>
      <button
        type="button"
        aria-label="关闭这条错误"
        title="关闭"
        className="-m-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => {
          if (owner !== undefined) useChat.getState().dismissNotice(item.id, owner);
          else {
            dismissedReadOnlyErrors.add(item);
            setDismissed(item);
          }
        }}
      >
        <X aria-hidden className="size-3.5" />
      </button>
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

function MetadataMessage({
  item,
}: {
  item: Extract<ChatItem, { kind: 'statistics' | 'fork-point' | 'compaction' | 'turn-status' }>;
}) {
  if (item.kind === 'turn-status')
    return (
      <p role="status" className="text-sm leading-6 text-muted-foreground">
        原生结果包含无法确认归属的错误。请核对本轮答复与原生记录；如有待发消息，列表会暂停等待确认。
      </p>
    );
  if (item.kind === 'statistics') return <StatisticsLine statistics={item} />;
  if (item.kind === 'fork-point') return <SessionForkPoint pointId={item.pointId} />;
  return <CompactionStatus state={item.state} incomplete={item.incomplete} />;
}

/** 单个对话条目；memo 避免流式更新时整列表重渲染（条目内容不变时引用不变） */
export const MessageItem = memo(function MessageItem({
  item,
  expanded,
  onExpandedChange,
}: { item: ChatItem } & ExpandedProps) {
  switch (item.kind) {
    case 'async-question':
      return <AsyncQuestionCard item={item} />;
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
    case 'permission':
      return <PermissionCard item={item} />;
    case 'interaction':
      return <InteractionCard item={item} />;
    case 'error':
      return <ErrorMessage item={item} />;
    default:
      return <MetadataMessage item={item} />;
  }
});
