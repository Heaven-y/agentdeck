import { useChat } from '../state/chat-store';
import type { ChatItem } from '../../conversation/model/conversation-events';
import { InteractionCard } from './InteractionCard';
import { followupStatusLabels } from '../followups/FollowupQueue';
import { buttonClass } from '../../../ui/styles';
type Item = Extract<ChatItem, { kind: 'async-question' }>;
export function AsyncQuestionCard({ item }: { item: Item }) {
  const respond = useChat((state) => state.respondAsyncQuestion);
  const dismiss = useChat((state) => state.dismissAsyncQuestion);
  const connected = useChat((state) => state.connection === 'open');
  const verify = useChat((state) => state.verifyAsyncQuestion);
  if (item.dismissed) return <p className="text-xs text-muted-foreground">已关闭此非阻塞问题</p>;
  const interaction = {
    ...item.question.spec,
    id: item.id,
    owner: { kind: 'session' as const, id: item.question.sessionId, runtimeId: 'native-history' },
  };
  return (
    <div className="space-y-2">
      <p className="text-xs leading-5 text-muted-foreground">非阻塞问题，回答将排队发送；本轮结束后仍可回答。</p>
      {item.status !== 'open' ? (
        <section aria-label={interaction.title} className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm font-medium">{interaction.title}</p>
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {item.status === 'accepted' ? '已回答' : followupStatusLabels[item.status]}
          </p>
        </section>
      ) : (
        <InteractionCard
          item={{ kind: 'interaction', id: item.id, interaction, responding: item.responding }}
          initialAnswer={item.answer}
          disabled={!!item.recovery || !connected}
          onAnswer={(answer) => {
            if (answer.action === 'cancel') {
              dismiss(item.question);
              return true;
            }
            return respond(item.question, answer);
          }}
        />
      )}
      {item.recovery && (
        <button
          type="button"
          className={buttonClass('outline')}
          disabled={!connected || item.recovery.checking}
          onClick={() => {
            void verify(item.question);
          }}
        >
          {item.recovery.checking ? '正在核对原生历史…' : '核对原生历史'}
        </button>
      )}
      {item.error && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {item.error}
        </p>
      )}
    </div>
  );
}
