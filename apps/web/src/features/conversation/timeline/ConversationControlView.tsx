import type { InteractionSpec } from '@agentdeck/shared/conversation';
import { useConversationSurface, type ConversationControl } from '../ConversationSurface';
import { shortToolName } from './tool-presentation';

const permissionStatus = { allow: '已批准', deny: '已拒绝', cancelled: '已结束或取消' } as const;
const interactionStatus = {
  completed: '已完成',
  submitted: '已提交',
  declined: '已拒绝',
  cancelled: '已取消或结束',
} as const;
const questionStatus = {
  open: '暂无回答记录',
  accepted: '已回答',
  cancelled: '已关闭',
  queued: '已排队',
  dispatching: '发送中',
  unknown: '可能已发送',
  failed: '发送失败',
} as const;

function RecordedPrompt({ spec, status }: { spec: InteractionSpec; status: string }) {
  return (
    <section
      aria-label={spec.title}
      className="min-w-0 space-y-2 rounded-xl border border-border bg-card p-3 text-[13px]"
    >
      <p className="break-words font-medium">{spec.title}</p>
      {spec.kind === 'url' ? (
        <p className="text-xs text-muted-foreground">网页授权记录</p>
      ) : (
        spec.fields.length > 0 && (
          <ul className="space-y-1 break-words text-muted-foreground">
            {spec.fields.map((field) => (
              <li key={field.id}>
                <span>{field.label}</span>
                {field.description && <p>{field.description}</p>}
                {field.type === 'choice' && <p>{field.options.map((option) => option.label).join(' · ')}</p>}
              </li>
            ))}
          </ul>
        )
      )}
      <p className="text-xs text-muted-foreground">{status}</p>
    </section>
  );
}

function RecordedControl({ item }: { item: ConversationControl }) {
  switch (item.kind) {
    case 'fork-point':
      return null;
    case 'interaction':
      return (
        <RecordedPrompt
          spec={item.interaction}
          status={item.resolved ? interactionStatus[item.resolved] : '暂无处理结果'}
        />
      );
    case 'async-question':
      return <RecordedPrompt spec={item.question.spec} status={questionStatus[item.status]} />;
    case 'permission':
      return (
        <section className="min-w-0 space-y-2 rounded-r-xl border-l-2 border-border bg-sidebar p-3 text-[13px]">
          <p className="font-medium">权限请求：{shortToolName(item.toolName)}</p>
          {item.description && <p className="break-words text-muted-foreground">{item.description}</p>}
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
            {JSON.stringify(item.input, null, 2)}
          </pre>
          <p className="text-xs text-muted-foreground">
            {item.resolved ? permissionStatus[item.resolved] : '暂无处理结果'}
          </p>
        </section>
      );
  }
}

export function ConversationControlView({ item }: { item: ConversationControl }) {
  const { Control = RecordedControl } = useConversationSurface();
  return <Control item={item} />;
}
