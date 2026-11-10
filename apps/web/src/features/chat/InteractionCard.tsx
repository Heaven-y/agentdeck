import { useId, useState } from 'react';
import {
  InteractionAnswerSchema,
  interactionAnswerErrors,
  type InteractionAnswer,
} from '@agentdeck/shared/conversation';
import { buttonClass } from '../../ui/styles';
import { useChat } from './chat-store';
import type { ChatItem } from './chat-reducer';
import { InteractionFieldInput, type FormValue } from './InteractionFields';

type Props = { item: Extract<ChatItem, { kind: 'interaction' }>; onAnswer?: (answer: InteractionAnswer) => boolean };
export function InteractionCard({ item, onAnswer }: Props) {
  const spec = item.interaction;
  return (
    <section
      aria-label={spec.title}
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 text-foreground"
    >
      <div>
        <p className="font-medium text-sm break-words">{spec.title}</p>
        {spec.source && <p className="mt-1 text-xs text-muted-foreground">{spec.source}</p>}
      </div>
      {item.resolved ? (
        <p role="status" className="text-xs text-muted-foreground">
          {resolutionText(item)}
        </p>
      ) : (
        <PendingInteraction key={item.id} item={item} onAnswer={onAnswer} />
      )}
    </section>
  );
}
function resolutionText(item: Props['item']) {
  if (item.resolved === 'completed') return '原生服务已确认完成';
  if (item.resolved === 'submitted')
    return item.interaction.kind === 'url' ? '已提交，授权结果以原生反馈为准。' : '已提交回答';
  return item.resolved === 'declined' ? '已拒绝' : '已取消或结束';
}
function PendingInteraction({ item, onAnswer }: Props) {
  const prefix = useId();
  const respond = useChat((state) => state.respondInteraction);
  const connected = useChat((state) => state.connection === 'open');
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const spec = item.interaction;
  const disabled = (!connected && !onAnswer) || !!item.responding;
  const answer = (value: InteractionAnswer) => {
    if (!InteractionAnswerSchema.safeParse(value).success) {
      setErrors({ _form: '答复内容过大或格式不正确，请缩短后重试。' });
      return;
    }
    const invalid = interactionAnswerErrors(spec, value);
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    if (!(onAnswer ? onAnswer(value) : respond(item.id, value))) setErrors({ _form: '答复未发送，请检查连接后重试。' });
  };
  const change = (id: string, value?: FormValue) =>
    setValues((current) => {
      const next = { ...current };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        answer({ action: 'submit', values });
      }}
    >
      {spec.kind === 'url' ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground break-words">请在原生服务页面完成操作后确认。</p>
          <a className={`${buttonClass('outline')} break-all`} href={spec.url} target="_blank" rel="noreferrer">
            打开 {new URL(spec.url).hostname}
          </a>
        </div>
      ) : (
        spec.fields.map((field) => (
          <InteractionFieldInput
            key={field.id}
            field={field}
            value={values[field.id]}
            change={(value) => change(field.id, value)}
            error={errors[field.id]}
            disabled={disabled}
            prefix={prefix}
          />
        ))
      )}
      {errors._form && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {errors._form}
        </p>
      )}
      {item.responding && (
        <p role="status" className="text-xs text-muted-foreground">
          正在提交…
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={buttonClass('ghost')}
          disabled={disabled}
          onClick={() => answer({ action: 'cancel' })}
        >
          取消
        </button>
        {spec.kind !== 'questions' && (
          <button
            type="button"
            className={buttonClass('outline')}
            disabled={disabled}
            onClick={() => answer({ action: 'decline' })}
          >
            拒绝
          </button>
        )}
        <button type="submit" className={buttonClass('primary')} disabled={disabled}>
          {spec.kind === 'url' ? '已完成此步骤' : '提交回答'}
        </button>
      </div>
    </form>
  );
}

export function NativeInteractionInbox() {
  const items = useChat((state) => state.nativeInteractions);
  const dismiss = useChat((state) => state.dismissInteraction);
  if (!items.length) return null;
  const item = items.find((item) => item.kind === 'interaction' && !item.resolved) ?? items[0];
  if (item?.kind !== 'interaction') return null;
  return (
    <aside
      aria-label="原生待处理请求"
      className="fixed bottom-4 right-4 z-[70] max-h-[75vh] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-xl bg-card shadow-xl"
    >
      <InteractionCard key={item.id} item={item} />
      {item.resolved && (
        <div className="flex justify-end p-2">
          <button type="button" className={buttonClass('ghost')} onClick={() => dismiss(item.id)}>
            关闭
          </button>
        </div>
      )}
    </aside>
  );
}
