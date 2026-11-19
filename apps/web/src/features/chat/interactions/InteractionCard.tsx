import { useId, useState } from 'react';
import {
  InteractionAnswerSchema,
  interactionAnswerErrors,
  type InteractionAnswer,
} from '@agentdeck/shared/conversation';
import { buttonClass } from '../../../ui/styles';
import { useChat } from '../state/chat-store';
import type { ChatItem } from '../../conversation/model/conversation-events';
import { InteractionFieldInput, type FormValue } from './InteractionFields';

type Props = {
  item: Extract<ChatItem, { kind: 'interaction' }>;
  onAnswer?: (answer: InteractionAnswer) => boolean;
  initialAnswer?: InteractionAnswer;
  disabled?: boolean;
};
type InteractionSpec = Props['item']['interaction'];

function answerErrors(spec: Props['item']['interaction'], value: InteractionAnswer) {
  if (!InteractionAnswerSchema.safeParse(value).success) return { _form: '答复内容过大或格式不正确，请缩短后重试。' };
  const errors = interactionAnswerErrors(spec, value);
  return Object.keys(errors).length ? errors : undefined;
}

function updateValues(current: Record<string, FormValue>, id: string, value?: FormValue) {
  const next = { ...current };
  if (value === undefined) delete next[id];
  else next[id] = value;
  return next;
}

function sendAnswer(
  onAnswer: Props['onAnswer'],
  respond: (id: string, value: InteractionAnswer) => boolean,
  itemId: string,
  value: InteractionAnswer,
) {
  return onAnswer ? onAnswer(value) : respond(itemId, value);
}

function InteractionPrompt({
  spec,
  values,
  errors,
  disabled,
  prefix,
  responding,
  change,
}: {
  spec: InteractionSpec;
  values: Record<string, FormValue>;
  errors: Record<string, string>;
  disabled: boolean;
  prefix: string;
  responding?: boolean;
  change(id: string, value?: FormValue): void;
}) {
  return (
    <>
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
      {responding && (
        <p role="status" className="text-xs text-muted-foreground">
          正在提交…
        </p>
      )}
    </>
  );
}

function InteractionActions({
  spec,
  disabled,
  answer,
}: {
  spec: InteractionSpec;
  disabled: boolean;
  answer(value: InteractionAnswer): void;
}) {
  return (
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
  );
}

export function InteractionCard({ item, onAnswer, initialAnswer, disabled }: Props) {
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
        <PendingInteraction
          key={item.id}
          item={item}
          onAnswer={onAnswer}
          initialAnswer={initialAnswer}
          disabled={disabled}
        />
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
function PendingInteraction({ item, onAnswer, initialAnswer, disabled: externallyDisabled }: Props) {
  const prefix = useId();
  const respond = useChat((state) => state.respondInteraction);
  const connected = useChat((state) => state.connection === 'open');
  const [values, setValues] = useState<Record<string, FormValue>>(
    initialAnswer?.action === 'submit' ? initialAnswer.values : {},
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const spec = item.interaction;
  const disabled = externallyDisabled || (!connected && !onAnswer) || !!item.responding;
  const answer = (value: InteractionAnswer) => {
    const invalid = answerErrors(spec, value);
    setErrors(invalid ?? {});
    if (invalid) return;
    if (!sendAnswer(onAnswer, respond, item.id, value)) setErrors({ _form: '答复未发送，请检查连接后重试。' });
  };
  const change = (id: string, value?: FormValue) => setValues((current) => updateValues(current, id, value));
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        answer({ action: 'submit', values });
      }}
    >
      <InteractionPrompt
        spec={spec}
        values={values}
        errors={errors}
        disabled={disabled}
        prefix={prefix}
        responding={item.responding}
        change={change}
      />
      <InteractionActions spec={spec} disabled={disabled} answer={answer} />
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
