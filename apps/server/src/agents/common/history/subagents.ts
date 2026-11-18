import {
  SubagentIdSchema,
  type AgentEvent,
  type SubagentQuery,
  type SubagentSummary,
} from '@agentdeck/shared/conversation';
import { SessionError } from '../../errors';

export const subagentMissing = () => new SessionError(404, 'session_missing', '此子代理记录不存在或归属尚未核实。');
export const subagentIncomplete = () =>
  new SessionError(503, 'session_history_incomplete', '子代理历史超过读取预算或关系异常，请缩小范围后重试。');
export type SubagentEdge = { agentId: string; name?: string; role?: string };
export type SubagentNode<T> = { id: string; depth: number; parentId?: string; value: T; summary?: SubagentSummary };
export type SubagentGraphApi<T> = {
  load(id: string, parent: SubagentNode<T> | undefined): Promise<T>;
  validate(value: T, id: string, parent?: SubagentNode<T>): Promise<boolean>;
  children(value: T): SubagentEdge[];
  status(value: T): SubagentSummary['status'];
  describe?(value: T): { name?: string; role?: string };
};
export type SubagentGraphInput = { id: string; query: SubagentQuery; signal?: AbortSignal; findId?: string };

/** 只从根历史中的已知边向下遍历；网页提供的 ID 永远不能成为原生读取起点。 */
class SubagentTree<T> {
  private bytes = 0;
  private reads = 0;
  private readonly deadline = Date.now() + 30_000;
  private readonly seen: Set<string>;
  constructor(
    private readonly api: SubagentGraphApi<T>,
    private readonly input: SubagentGraphInput,
  ) {
    this.seen = new Set([input.id]);
  }
  private summary(value: T, parent: SubagentNode<T>, edge: SubagentEdge): SubagentSummary {
    return {
      ...edge,
      parentSessionId: this.input.id,
      ...(parent.id !== this.input.id ? { parentAgentId: parent.id } : {}),
      ...this.api.describe?.(value),
      status: this.api.status(value),
    };
  }
  private async load(id: string, parent?: SubagentNode<T>, edge?: SubagentEdge): Promise<SubagentNode<T> | undefined> {
    this.checkBudget();
    const value = await this.api.load(id, parent);
    this.input.signal?.throwIfAborted();
    this.bytes += Buffer.byteLength(JSON.stringify(value));
    if (this.bytes > 32 * 1024 * 1024 || Date.now() > this.deadline) throw subagentIncomplete();
    if (!(await this.api.validate(value, id, parent))) return;
    this.input.signal?.throwIfAborted();
    return {
      id,
      value,
      depth: parent ? parent.depth + 1 : 0,
      parentId: parent?.id,
      summary: parent && edge ? this.summary(value, parent, edge) : undefined,
    };
  }
  private checkBudget() {
    this.input.signal?.throwIfAborted();
    if (++this.reads > 128 || Date.now() > this.deadline) throw subagentIncomplete();
  }
  private async child(parent: SubagentNode<T>, edge: SubagentEdge) {
    try {
      return await this.load(edge.agentId, parent, edge);
    } catch (error) {
      this.input.signal?.throwIfAborted();
      if (Date.now() > this.deadline) throw subagentIncomplete();
      // 只有正式原生 reader 明确裁决为不存在/归属不匹配的节点可被目录淘汰。
      // 根读取、预算、取消及运行错误均保持失败，不能伪装成空目录。
      if (error instanceof SessionError && error.status === 404 && error.code === 'session_missing') return;
      throw error;
    }
  }
  private async children(parent: SubagentNode<T>) {
    const edges = [
      ...new Map(
        this.api
          .children(parent.value)
          .filter((edge) => SubagentIdSchema.safeParse(edge.agentId).success)
          .map((edge) => [edge.agentId, edge]),
      ).values(),
    ];
    if (edges.length && parent.depth >= 10) throw subagentIncomplete();
    const children: SubagentNode<T>[] = [];
    for (const edge of edges) {
      if (this.seen.has(edge.agentId)) throw subagentIncomplete();
      this.seen.add(edge.agentId);
      if (this.seen.size > 128) throw subagentIncomplete();
      const child = await this.child(parent, edge);
      if (child) children.push(child);
    }
    return children;
  }
  async find() {
    const root = await this.load(this.input.id);
    if (!root) throw subagentMissing();
    const queue = [root];
    const { findId, query, signal, id } = this.input;
    while (queue.length) {
      const parent = queue.shift()!;
      const children = await this.children(parent);
      const selected = children.find((child) => child.id === (findId ?? query.agentId));
      if (findId ? !!selected : parent.id === (query.parentAgentId ?? id)) {
        if (query.agentId && !selected) throw subagentMissing();
        signal?.throwIfAborted();
        return { selected, children };
      }
      queue.push(...children);
    }
    throw subagentMissing();
  }
}
export function subagentGraph<T>(api: SubagentGraphApi<T>, input: SubagentGraphInput) {
  return new SubagentTree(api, input).find();
}

/** 独立历史保留自身用量，移除父会话管理位置；媒体始终通过根会话重新核实归属。 */
export function subagentEvents(events: AgentEvent[], rootId: string, childId: string): AgentEvent[] {
  return events.map((event) => {
    if (event.type === 'async_question')
      return {
        type: 'text',
        delta: readonlyQuestion(event.question.spec),
      };
    if (event.type === 'turn_end') {
      const { forkPoint: _fork, ...safe } = event;
      return safe;
    }
    if ((event.type === 'user_message' || event.type === 'tool_result') && event.attachments)
      return {
        ...event,
        attachments: event.attachments.map((media) =>
          media.kind === 'native-image'
            ? {
                ...media,
                locator: { ...media.locator, sessionId: rootId, subagentId: childId },
              }
            : media,
        ),
      };
    return event;
  });
}
function readonlyQuestion(spec: Extract<AgentEvent, { type: 'async_question' }>['question']['spec']) {
  const body = spec.fields
    .map((field) =>
      field.type === 'choice'
        ? `${field.label}\n选项：${field.options.map((option) => option.label).join('、')}`
        : field.label,
    )
    .join('\n');
  return `子代理提问（只读）：\n${body}`;
}
