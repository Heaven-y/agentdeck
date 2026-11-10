import { randomUUID } from 'node:crypto';
import {
  InteractionAnswerSchema,
  InteractionSpecSchema,
  interactionAnswerErrors,
  type InteractionAnswer,
  type InteractionOwner,
  type InteractionSpec,
  type InteractionResolution,
  type UserInteraction,
  type InteractionEvent,
} from '@agentdeck/shared/conversation';
export type InteractionContext = {
  channel: object;
  owner: InteractionOwner;
  completionId?: string;
  emit(event: InteractionEvent): void;
};
type Pending = {
  context: InteractionContext;
  interaction: UserInteraction;
  resolve(answer: InteractionAnswer): void;
  timer: NodeJS.Timeout;
  cleanup(): void;
  answered?: boolean;
};
const sameOwner = (left: InteractionOwner, right: InteractionOwner) =>
  left.kind === right.kind && left.id === right.id && left.runtimeId === right.runtimeId;
/** 交互拥有者可以是回合、会话或管理操作；秘密答案只交回等待方，不加入恢复事件。 */
export class InteractionHub {
  private readonly pending = new Map<string, Pending>();
  request(
    context: InteractionContext,
    spec: InteractionSpec,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<InteractionAnswer> {
    const parsed = InteractionSpecSchema.safeParse(spec);
    if (
      !parsed.success ||
      options.signal?.aborted ||
      this.pending.size >= 128 ||
      Buffer.byteLength(JSON.stringify(spec)) > 65_536
    )
      return Promise.resolve({ action: 'cancel' });
    if ([...this.pending.values()].filter((value) => value.context.channel === context.channel).length >= 32)
      return Promise.resolve({ action: 'cancel' });
    const interaction: UserInteraction = { ...parsed.data, id: randomUUID(), owner: context.owner };
    return new Promise((resolve) => {
      const abort = () => this.finish(interaction.id, { action: 'cancel' });
      const timer = setTimeout(abort, Math.min(options.timeoutMs ?? 300_000, 900_000));
      this.pending.set(interaction.id, {
        context,
        interaction,
        resolve,
        timer,
        cleanup: () => options.signal?.removeEventListener('abort', abort),
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      context.emit({ type: 'interaction_request', interaction });
    });
  }
  respond(channel: object, id: string, answer: InteractionAnswer): boolean {
    const pending = this.pending.get(id);
    if (!pending || pending.answered || pending.context.channel !== channel) return false;
    const parsed = InteractionAnswerSchema.safeParse(answer);
    if (!parsed.success || Object.keys(interactionAnswerErrors(pending.interaction, parsed.data)).length) return false;
    this.finish(id, parsed.data);
    return true;
  }
  private finish(id: string, answer: InteractionAnswer): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.answered) {
      this.remove(id, pending);
      pending.context.emit({ type: 'interaction_resolved', id, resolution: 'cancelled' });
      return;
    }
    if (answer.action === 'submit' && pending.interaction.kind === 'url' && pending.context.completionId)
      pending.answered = true;
    else this.remove(id, pending);
    const resolution: InteractionResolution =
      answer.action === 'submit' ? 'submitted' : answer.action === 'decline' ? 'declined' : 'cancelled';
    pending.context.emit({ type: 'interaction_resolved', id, resolution });
    pending.resolve(answer);
  }
  private remove(id: string, pending: Pending): void {
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup();
  }
  complete(channel: object, runtimeId: string, completionId: string): void {
    for (const [id, pending] of this.pending) {
      if (!matchesCompletion(pending, channel, runtimeId, completionId)) continue;
      this.remove(id, pending);
      pending.context.emit({ type: 'interaction_resolved', id, resolution: 'completed' });
      if (!pending.answered) pending.resolve({ action: 'submit', values: {} });
    }
  }
  cancelOwner(owner: InteractionOwner): void {
    for (const [id, p] of this.pending) if (sameOwner(p.context.owner, owner)) this.finish(id, { action: 'cancel' });
  }
  cancelTurn(turnId: string): void {
    for (const [id, p] of this.pending)
      if (p.context.owner.kind === 'turn' && p.context.owner.id === turnId) this.finish(id, { action: 'cancel' });
  }
  cancelRuntime(runtimeId: string): void {
    for (const [id, p] of this.pending)
      if (p.context.owner.runtimeId === runtimeId) this.finish(id, { action: 'cancel' });
  }
  cancelChannel(channel: object): void {
    for (const [id, p] of this.pending) if (p.context.channel === channel) this.finish(id, { action: 'cancel' });
  }
  dispose(): void {
    for (const id of this.pending.keys()) this.finish(id, { action: 'cancel' });
  }
}
function matchesCompletion(pending: Pending, channel: object, runtimeId: string, id: string): boolean {
  return (
    pending.interaction.kind === 'url' &&
    pending.context.channel === channel &&
    pending.context.owner.runtimeId === runtimeId &&
    pending.context.completionId === id
  );
}
