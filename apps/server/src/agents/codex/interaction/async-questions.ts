import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  AsyncQuestionSchema,
  InteractionAnswerSchema,
  interactionAnswerErrors,
  type AsyncQuestion,
  type InteractionAnswer,
  type InteractionField,
  type AgentEvent,
} from '@agentdeck/shared/conversation';

const NativeQuestion = z.object({
  title: z.string().min(1).max(2000),
  options: z
    .array(z.string().min(1).max(2000))
    .min(1)
    .max(20)
    .refine((values) => new Set(values).size === values.length)
    .optional(),
});
const NativeQuestions = z.object({
  type: z.literal('agentMessage'),
  id: z.string().min(1).max(512),
  delivery: z.literal('async'),
  questions: z.array(NativeQuestion).min(1).max(4),
});
/** 默认模式的questions是消息元数据，没有RPC答复方法；无效结构继续展示原文字。 */
export function codexAsyncQuestion(item: unknown, sessionId?: string): AsyncQuestion | undefined {
  if (!sessionId) return;
  const parsed = NativeQuestions.safeParse(item);
  if (!parsed.success) return;
  const fields: InteractionField[] = parsed.data.questions.map((question, index) => ({
    id: `q${index}`,
    label: question.title,
    required: true,
    ...(question.options
      ? {
          type: 'choice' as const,
          multiple: false,
          allowOther: true,
          options: question.options.map((option) => ({ value: option, label: option })),
        }
      : { type: 'text' as const, maxLength: 16_384 }),
  }));
  const result = AsyncQuestionSchema.safeParse({
    sessionId,
    messageId: parsed.data.id,
    spec: { kind: 'questions', title: '补充信息', source: 'Codex', blocking: false, fields },
  });
  return result.success ? result.data : undefined;
}
export function codexAsyncAnswerText(question: AsyncQuestion, answer: InteractionAnswer): string {
  if (
    !InteractionAnswerSchema.safeParse(answer).success ||
    answer.action !== 'submit' ||
    Object.keys(interactionAnswerErrors(question.spec, answer)).length ||
    question.spec.kind !== 'questions'
  )
    throw new Error('请完成此问题的回答。');
  return `${asyncAnswerMarker(question)}\n${question.spec.fields.map((field) => `${field.label}：${String(answer.values[field.id])}`).join('\n')}`;
}
/** 只把稳定摘要带入原生正文；重启后由原生历史确认已答，不另建答案数据库。 */
export function asyncAnswerId(question: Pick<AsyncQuestion, 'sessionId' | 'messageId'>): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([question.sessionId, question.messageId]))
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function asyncAnswerMarker(question: Pick<AsyncQuestion, 'sessionId' | 'messageId'>): string {
  return `对原生提问的回答（${asyncAnswerId(question)}）：`;
}
export function markAnsweredQuestions(events: AgentEvent[], paged = false): AgentEvent[] {
  const answers = events.filter((event) => event.type === 'user_message').map((event) => event.text);
  return events.map((event) => {
    if (event.type !== 'async_question') return event;
    const marker = asyncAnswerMarker(event.question);
    return {
      ...event,
      ...(answers.some((text) => text.startsWith(marker)) ? { answered: true } : {}),
      ...(paged ? { historyAnswerMarker: marker } : {}),
    };
  });
}
