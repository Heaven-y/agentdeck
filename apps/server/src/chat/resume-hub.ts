import type {
  ClientMessage,
  RecoveryFailureCode,
  RecoveryNotice,
  ResumeRequest,
  ServerMessage,
  RecoveryTurn,
  FollowupSnapshot,
  RuntimeTasksState,
} from '@agentdeck/shared/conversation';
import type { Socket, TurnManager } from './turn-manager';

export type ResumePeer = { send(data: string): void; isOpen(): boolean; close?(): void };
export type ResumeLimits = {
  offlineMs: number;
  completedMs: number;
  ownerBytes: number;
  totalBytes: number;
  owners: number;
};
const DEFAULT_LIMITS: ResumeLimits = {
  offlineMs: 60_000,
  completedMs: 300_000,
  ownerBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  owners: 64,
};
type SavedTurn = RecoveryTurn & { bytes: number; turnId?: string; completedAt?: number };
type SavedEvent = { sequence: number; data: string; bytes: number; clientTurnId?: string; interactionId?: string };
type Owner = {
  token: string;
  socket: Socket;
  peer?: ResumePeer;
  instanceId?: string;
  offlineAt?: number;
  sequence: number;
  floor: number;
  bytes: number;
  turns: Map<string, SavedTurn>;
  interactions: Map<string, { completedAt?: number; awaitingCompletion?: boolean }>;
  followups: Map<string, { snapshot: FollowupSnapshot; bytes: number }>;
  tasks: Map<string, { state: RuntimeTasksState; bytes: number }>;
  events: SavedEvent[];
};
const messages: Record<RecoveryFailureCode, string> = {
  owner_missing: '本轮回复未能完整恢复，请重新读取会话。消息不会自动重发。',
  owner_connected: '原窗口仍在使用此连接，本窗口将重新连接。',
  cache_expired: '本轮回复未能完整恢复，请重新读取会话。消息不会自动重发。',
  capacity: '恢复记录已满，本连接的任务已停止。请重新读取会话。',
  server_closed: '服务已关闭，本轮已停止。重新连接后可读取会话。',
};
const sizeOf = (data: string) => data.length * 2 + 128;
function messageClientId(owner: Owner, message: ServerMessage): string | undefined {
  if ('clientTurnId' in message && message.clientTurnId) return message.clientTurnId;
  if (!('turnId' in message) || !message.turnId) return;
  return [...owner.turns].find(([, turn]) => turn.turnId === message.turnId)?.[0];
}
function recordTurn(owner: Owner, message: ServerMessage): string | undefined {
  const id = messageClientId(owner, message);
  const turn = id ? owner.turns.get(id) : undefined;
  if (!turn) return id;
  if (message.type === 'turn.started') turn.turnId = message.turnId;
  if (message.type === 'turn.finished' || (message.type === 'error' && !message.turnId)) turn.completedAt = Date.now();
  return id;
}

/** 运行器只持有稳定代理；短暂离线时代理仍可接收输出和审批。 */
export class ResumeHub {
  private owners = new Map<string, Owner>();
  private totalBytes = 0;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  private limits: ResumeLimits;

  constructor(
    private turns: Pick<TurnManager, 'handle' | 'socketClosed'> & Partial<Pick<TurnManager, 'socketOffline'>>,
    limits: Partial<ResumeLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.timer = setInterval(() => this.prune(), Math.min(this.limits.offlineMs, this.limits.completedMs, 1000));
    this.timer.unref();
  }

  attach(peer: ResumePeer, request: ResumeRequest): Socket | undefined {
    this.prune();
    if (this.closed) return this.reject(peer, 'server_closed');
    const owner = this.findOwner(peer, request);
    if (!owner) return;
    if (request.afterSequence > owner.sequence || (!request.rebuild && request.afterSequence < owner.floor)) {
      this.remove(owner);
      return this.reject(peer, 'cache_expired');
    }
    this.replacePeer(owner, peer, request.instanceId);
    this.replay(owner, peer, request);
    return owner.socket;
  }
  private replay(owner: Owner, peer: ResumePeer, request: ResumeRequest): void {
    if (request.rebuild)
      this.notify(peer, {
        type: 'connection.snapshot',
        turns: [...owner.turns.values()].map(({ message, sentAt }) => ({ message, sentAt })),
      });
    for (const event of owner.events) {
      if (request.rebuild || event.sequence > request.afterSequence) peer.send(event.data);
    }
    if (owner.followups.size)
      this.notify(peer, {
        type: 'connection.followups',
        snapshots: [...owner.followups.values()].map((value) => value.snapshot),
      });
    if (owner.tasks.size)
      this.notify(peer, { type: 'connection.tasks', states: [...owner.tasks.values()].map((value) => value.state) });
    this.notify(peer, {
      type: 'connection.ready',
      sequence: owner.sequence,
      acceptedClientTurnIds: [...owner.turns.keys()],
    });
  }

  private replacePeer(owner: Owner, peer: ResumePeer, instanceId?: string): void {
    owner.peer?.close?.();
    owner.peer = peer;
    owner.instanceId = instanceId;
    owner.offlineAt = undefined;
  }

  private findOwner(peer: ResumePeer, request: ResumeRequest): Owner | undefined {
    const owner = this.owners.get(request.token);
    if (owner) {
      const sameDocument = request.instanceId !== undefined && owner.instanceId === request.instanceId;
      if (owner.peer?.isOpen() && !sameDocument) return this.reject(peer, 'owner_connected');
      return owner;
    }
    if (!request.create) return this.reject(peer, 'owner_missing');
    if (this.owners.size >= this.limits.owners) return this.reject(peer, 'capacity');
    return this.createOwner(request.token);
  }

  async handle(peer: ResumePeer, socket: Socket, message: ClientMessage): Promise<void> {
    const owner = [...this.owners.values()].find((entry) => entry.socket === socket);
    if (!owner || owner.peer !== peer) return;
    if (message.type === 'chat.send') {
      if (!this.rememberInput(owner, message)) return;
    }
    await this.turns.handle(socket, message);
  }

  detach(peer: ResumePeer, socket: Socket): void {
    const owner = [...this.owners.values()].find((entry) => entry.socket === socket);
    if (!owner || owner.peer !== peer) return;
    owner.peer = undefined;
    owner.offlineAt = Date.now();
    this.turns.socketOffline?.(owner.socket);
  }
  /** HTTP附件请求必须来自仍拥有此恢复连接的页面，不以客户端会话ID授权。 */
  identity(token: string, instanceId: string): Socket | undefined {
    const owner = this.owners.get(token);
    return owner?.instanceId === instanceId && owner.peer?.isOpen() ? owner.socket : undefined;
  }

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const owner of this.owners.values()) this.remove(owner, 'server_closed');
  }

  private createOwner(token: string): Owner {
    const owner: Owner = {
      token,
      socket: {
        send: (message) => this.publish(owner, message),
        isOpen: () => this.owners.has(token),
        rememberInput: (message) => this.rememberInput(owner, message),
      },
      sequence: 0,
      floor: 0,
      bytes: 0,
      turns: new Map(),
      interactions: new Map(),
      followups: new Map(),
      tasks: new Map(),
      events: [],
    };
    this.owners.set(token, owner);
    return owner;
  }

  private publish(owner: Owner, message: ServerMessage): void {
    if (this.owners.get(owner.token) !== owner) return;
    if (message.type === 'followup.state') {
      this.saveFollowups(owner, message.snapshot);
      return;
    }
    if (message.type === 'tasks.state') {
      this.saveTasks(owner, message.state);
      return;
    }
    const clientTurnId = recordTurn(owner, message);
    const interactionId = recordInteraction(owner, message);
    const sequence = owner.sequence + 1;
    const data = JSON.stringify({ type: 'connection.event', sequence, message });
    const bytes = sizeOf(data);
    if (!this.reserve(owner, bytes)) return;
    owner.sequence = sequence;
    owner.events.push({ sequence, data, bytes, clientTurnId, interactionId });
    if (owner.peer?.isOpen()) owner.peer.send(data);
  }
  private rememberInput(owner: Owner, message: Extract<ClientMessage, { type: 'chat.send' }>): boolean {
    if (this.owners.get(owner.token) !== owner || owner.turns.has(message.clientTurnId)) return false;
    this.prune();
    if (this.owners.get(owner.token) !== owner) return false;
    const saved = { message, sentAt: Date.now(), bytes: sizeOf(JSON.stringify(message)) };
    if (!this.reserve(owner, saved.bytes)) return false;
    owner.turns.set(message.clientTurnId, saved);
    return true;
  }
  private saveFollowups(owner: Owner, snapshot: FollowupSnapshot): void {
    const bytes = sizeOf(JSON.stringify(snapshot));
    const delta = bytes - (owner.followups.get(snapshot.queueId)?.bytes ?? 0);
    if (delta > 0 && !this.reserve(owner, delta)) return;
    if (delta < 0) {
      owner.bytes += delta;
      this.totalBytes += delta;
    }
    owner.followups.set(snapshot.queueId, { snapshot, bytes });
    if (owner.peer?.isOpen()) this.notify(owner.peer, { type: 'connection.followups', snapshots: [snapshot] });
  }
  private saveTasks(owner: Owner, state: RuntimeTasksState): void {
    const bytes = sizeOf(JSON.stringify(state));
    const delta = bytes - (owner.tasks.get(state.runtimeId)?.bytes ?? 0);
    if (delta > 0 && !this.reserve(owner, delta)) return;
    if (delta < 0) {
      owner.bytes += delta;
      this.totalBytes += delta;
    }
    owner.tasks.set(state.runtimeId, { state, bytes });
    if (owner.peer?.isOpen()) this.notify(owner.peer, { type: 'connection.tasks', states: [state] });
  }

  private reserve(owner: Owner, bytes: number): boolean {
    if (owner.bytes + bytes > this.limits.ownerBytes || this.totalBytes + bytes > this.limits.totalBytes) {
      this.remove(owner, 'capacity');
      return false;
    }
    owner.bytes += bytes;
    this.totalBytes += bytes;
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const owner of this.owners.values()) {
      if (owner.offlineAt !== undefined && now - owner.offlineAt >= this.limits.offlineMs) {
        this.remove(owner);
        continue;
      }
      const expired = new Set(
        [...owner.turns]
          .filter(([, turn]) => turn.completedAt !== undefined && now - turn.completedAt >= this.limits.completedMs)
          .map(([id]) => id),
      );
      for (const id of expired) {
        const turn = owner.turns.get(id)!;
        owner.bytes -= turn.bytes;
        this.totalBytes -= turn.bytes;
        owner.turns.delete(id);
      }
      const expiredInteractions = new Set(
        [...owner.interactions]
          .filter(([, value]) => value.completedAt !== undefined && now - value.completedAt >= this.limits.completedMs)
          .map(([id]) => id),
      );
      for (const id of expiredInteractions) owner.interactions.delete(id);
      owner.events = owner.events.filter((event) => {
        if (!expiredEvent(event, expired, expiredInteractions)) return true;
        owner.bytes -= event.bytes;
        this.totalBytes -= event.bytes;
        owner.floor = Math.max(owner.floor, event.sequence);
        return false;
      });
    }
  }

  private remove(owner: Owner, code?: RecoveryFailureCode): void {
    this.owners.delete(owner.token);
    this.totalBytes -= owner.bytes;
    if (code && owner.peer?.isOpen()) this.reject(owner.peer, code);
    this.turns.socketClosed(owner.socket);
  }
  private notify(peer: ResumePeer, message: RecoveryNotice): void {
    if (peer.isOpen()) peer.send(JSON.stringify(message));
  }
  private reject(peer: ResumePeer, code: RecoveryFailureCode): undefined {
    this.notify(peer, { type: 'connection.rejected', code, message: messages[code] });
    return undefined;
  }
}

function recordInteraction(owner: Owner, message: ServerMessage): string | undefined {
  if (message.type !== 'interaction.event') return;
  const event = message.event;
  if (event.type === 'interaction_request') {
    owner.interactions.set(event.interaction.id, { awaitingCompletion: event.interaction.kind === 'url' });
    return event.interaction.id;
  }
  const previous = owner.interactions.get(event.id);
  owner.interactions.set(
    event.id,
    event.resolution === 'submitted' && previous?.awaitingCompletion ? previous : { completedAt: Date.now() },
  );
  return event.id;
}
function expiredEvent(event: SavedEvent, turns: Set<string>, interactions: Set<string>): boolean {
  return (
    (!!event.clientTurnId && turns.has(event.clientTurnId)) ||
    (!!event.interactionId && interactions.has(event.interactionId))
  );
}
