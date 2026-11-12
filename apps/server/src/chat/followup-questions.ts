import type {
  AsyncQuestion,
  AsyncQuestionState,
  FollowupItem,
  InteractionAnswer,
} from '@agentdeck/shared/conversation';
import { AsyncQuestionSchema } from '@agentdeck/shared/conversation';
import { asyncAnswerId, codexAsyncAnswerText } from '../agents/codex/async-questions';
import { SessionError } from '../agents/errors';

/** 仅保留本连接已核实的问题与答复状态，正文仍以原生会话为准。 */
export class FollowupQuestions {
  private readonly entries = new Map<string, AsyncQuestionState>();
  private readonly live = new Set<string>();
  observeLive(question: AsyncQuestion): void {
    this.observe(question);
    this.live.add(question.messageId);
  }
  isLive(id: string): boolean {
    return this.live.has(id);
  }
  endTurn(): void {
    this.live.clear();
  }
  observe(question: AsyncQuestion, answered = false): void {
    const parsed = AsyncQuestionSchema.safeParse(question);
    if (!parsed.success) return;
    const existing = this.entries.get(question.messageId);
    if (existing) {
      if (answered) existing.status = 'accepted';
      return;
    }
    if (this.entries.size >= 32) {
      const completed = [...this.entries].find(([, entry]) => ['accepted', 'cancelled'].includes(entry.status));
      if (!completed) return;
      this.entries.delete(completed[0]);
    }
    this.entries.set(question.messageId, { question: parsed.data, status: answered ? 'accepted' : 'open' });
  }
  get(id: string): AsyncQuestionState | undefined {
    return this.entries.get(id);
  }
  snapshot(items: FollowupItem[]): AsyncQuestionState[] {
    for (const entry of this.entries.values()) {
      const item = items.find((item) => item.clientMessageId === entry.clientMessageId);
      if (item && entry.status !== 'accepted') entry.status = item.status;
    }
    return structuredClone([...this.entries.values()]);
  }
  prepare(id: string, answer: InteractionAnswer): { clientMessageId: string; text: string } | undefined {
    const entry = this.entries.get(id);
    if (!entry) throw new SessionError(404, 'question_missing', '此提问已不可读取，请重新读取原生历史。');
    if (['accepted', 'cancelled'].includes(entry.status)) return;
    if (answer.action !== 'submit') {
      if (entry.clientMessageId)
        throw new SessionError(409, 'question_pending', '回答已加入待发列表，请从待发列表处理。');
      entry.status = 'cancelled';
      return;
    }
    return { clientMessageId: asyncAnswerId(entry.question), text: codexAsyncAnswerText(entry.question, answer) };
  }
  submitted(id: string, clientMessageId: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.clientMessageId = clientMessageId;
      entry.status = 'queued';
    }
  }
}
