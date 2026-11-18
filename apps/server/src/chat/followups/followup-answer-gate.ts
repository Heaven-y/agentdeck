import type { AgentKind, AsyncQuestionState, FollowupStatus } from '@agentdeck/shared/conversation';
import { SessionError } from '../../agents/errors';

type Receipt = { queueId: string; status: FollowupStatus; expires?: number };
type Scope = { workspaceId: string; agent: AgentKind; sessionId?: string };
const full = () => new SessionError(409, 'question_pending', '问题答复仍未核实或恢复记录已满，请核对原列表。');
/** 跨恢复owner只保存稳定身份和投递状态，不保存题目或答案正文。 */
export class FollowupAnswerGate {
  private readonly receipts = new Map<string, Receipt>();
  private readonly locks = new Map<string, Promise<void>>();
  async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.prune();
    if (!this.receipts.has(id) && this.receipts.size + this.locks.size >= 1000) throw full();
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    this.locks.set(id, next);
    await previous;
    // 注册释放器后才进入异步核题，两个owner的相同身份不能同时通过。
    await Promise.resolve();
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  get(id: string): Receipt | undefined {
    return this.receipts.get(id);
  }
  claim(id: string, queueId: string, status: FollowupStatus): void {
    const old = this.receipts.get(id);
    if (old && old.queueId !== queueId && old.status !== 'cancelled') throw full();
    this.receipts.set(id, { queueId, status });
  }
  observe(queueId: string, scope: Scope, questions: AsyncQuestionState[]): void {
    if (!scope.sessionId) return;
    for (const question of questions) this.observeQuestion(queueId, scope, question);
  }
  private observeQuestion(queueId: string, scope: Scope, question: AsyncQuestionState) {
    if (!question.clientMessageId || question.status === 'open') return;
    const id = followupQuestionIdentity(scope, question.question.messageId),
      old = this.receipts.get(id),
      status = question.status;
    if (!canApplyReceipt(old, queueId, status)) return;
    this.receipts.set(id, {
      queueId,
      status,
      ...(status === 'accepted' ? { expires: old?.expires ?? Date.now() + 30 * 60_000 } : {}),
    });
  }
  discard(queueId: string): void {
    for (const [id, receipt] of this.receipts) {
      if (receipt.queueId !== queueId) continue;
      if (['queued', 'failed', 'cancelled'].includes(receipt.status)) this.receipts.delete(id);
      else if (receipt.status === 'dispatching') receipt.status = 'unknown';
    }
  }
  private prune(): void {
    for (const [id, receipt] of this.receipts)
      if (receipt.expires && receipt.expires <= Date.now() && !this.locks.has(id)) this.receipts.delete(id);
  }
}
export function followupQuestionIdentity(scope: Scope, messageId: string) {
  return JSON.stringify([scope.agent, scope.workspaceId, scope.sessionId, messageId]);
}
function canApplyReceipt(old: Receipt | undefined, queueId: string, status: FollowupStatus) {
  return !(old && old.queueId !== queueId) && !(old?.status === 'unknown' && status === 'cancelled');
}
