import type { InteractionAnswer, InteractionSpec } from '@agentdeck/shared/conversation';
import type { AgentTurnInput } from '../../contracts';
import type { CodexClient } from '../run/client';
import type { CodexTasks } from '../tasks/tasks';
import { record, text, type RecordValue, type RpcId, type ServerRequest } from '../run/types';
import { codexPermissionResponse } from './permissions';
import { isMcpToolApproval } from './mcp-approval';
import { codexQuestion, nativeElicitation } from '../../common/interaction/user-interactions';

type Pending = { request: ServerRequest; controller: AbortController; threadId: string; turnId: string };
type Prepared = { spec: InteractionSpec; answer(value: InteractionAnswer): RecordValue };
type Options = {
  client: Pick<CodexClient, 'respond' | 'rejectRequest'>;
  tasks: Pick<CodexTasks, 'settled' | 'owns'>;
  runtimeId: string;
  sessionId(): string | undefined;
};
const approvalMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
/** 子代理请求只沿已发现并核验的本实例父链进入；答案回原RPC，绝不伪装成父回合请求。 */
export class CodexChildRequests {
  private readonly owners = new Map<string, AgentTurnInput>();
  private readonly pending = new Map<RpcId, Pending>();
  private closed = false;
  constructor(private readonly options: Options) {}
  remember(id: string, input: AgentTurnInput): void {
    if (this.owners.size >= 128 || this.owners.has(id)) return;
    this.owners.set(id, { ...input, text: '', attachments: undefined, attachmentsStored: undefined });
  }
  forget(id: string): void {
    this.owners.delete(id);
  }
  request(request: ServerRequest): boolean {
    if (request.params.threadId === this.options.sessionId()) return false;
    if (this.pending.has(request.id)) return true;
    const pending = {
      request,
      controller: new AbortController(),
      threadId: text(request.params.threadId),
      turnId: text(request.params.turnId),
    };
    if (this.closed || this.pending.size >= 32) {
      this.options.client.rejectRequest(request.id);
      return true;
    }
    this.pending.set(request.id, pending);
    void this.answer(pending);
    return true;
  }
  private async answer(pending: Pending): Promise<void> {
    const { request, threadId, turnId, controller } = pending;
    try {
      await this.options.tasks.settled();
      if (controller.signal.aborted || !this.pending.has(request.id)) return;
      const { input, sessionId } = this.target(threadId, turnId);
      const prepared = prepare(request);
      const answer = await input.requestInteraction?.(
        {
          runtimeId: this.options.runtimeId,
          scope: { kind: 'session', id: sessionId },
          spec: { ...prepared.spec, source: `Codex · 子代理 ${threadId}` },
        },
        { signal: controller.signal },
      );
      if (!this.pending.delete(request.id) || controller.signal.aborted) return;
      this.options.client.respond(request.id, prepared.answer(answer ?? { action: 'cancel' }));
    } catch {
      if (this.pending.delete(request.id)) this.options.client.rejectRequest(request.id);
    }
  }
  private target(threadId: string, turnId: string): { input: AgentTurnInput; sessionId: string } {
    const input = this.owners.get(threadId),
      sessionId = this.options.sessionId();
    if (!input || !sessionId || !turnId || !this.options.tasks.owns(threadId, turnId)) throw new Error('未核实子请求');
    return { input, sessionId };
  }
  notify(method: string, params: RecordValue): void {
    if (method === 'serverRequest/resolved') {
      const id = params.requestId;
      if (typeof id === 'string' || typeof id === 'number') this.cancel(id, false);
    } else if (method === 'turn/completed') {
      for (const [id, pending] of this.pending)
        if (pending.threadId === params.threadId && pending.turnId === record(params.turn).id) this.cancel(id, true);
    }
  }
  private cancel(id: RpcId, respond: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.controller.abort();
    if (respond) {
      try {
        this.options.client.respond(id, prepare(pending.request).answer({ action: 'cancel' }));
      } catch {
        this.options.client.rejectRequest(id);
      }
    }
  }
  close(): void {
    this.closed = true;
    for (const id of this.pending.keys()) this.cancel(id, true);
    this.owners.clear();
  }
}
function prepare(request: ServerRequest): Prepared {
  if (request.method === 'item/tool/requestUserInput') return codexQuestion(request.params);
  if (request.method === 'mcpServer/elicitation/request') return nativeElicitation(request.params);
  if (!approvalMethods.has(request.method) && !isMcpToolApproval(request)) throw new Error('未知子代理请求');
  const scope =
    request.method === 'item/permissions/requestApproval' ? permissionsSummary(request.params.permissions) : '';
  const rawDescription =
    text(request.params.command) || text(request.params.reason) || '是否允许此子代理执行本次工具调用？';
  const description =
    rawDescription.length > 400 ? `${rawDescription.slice(0, 397)}…（请求说明已截断）` : rawDescription;
  const label = [description, scope].filter(Boolean).join('\n');
  return {
    spec: {
      kind: 'form',
      title: '子代理请求工具权限',
      blocking: true,
      fields: [
        {
          id: 'allow',
          type: 'choice',
          multiple: false,
          required: true,
          label,
          options: [
            { value: 'deny', label: '拒绝' },
            { value: 'allow', label: '允许本次' },
          ],
        },
      ],
    },
    answer: (value) =>
      codexPermissionResponse(
        request,
        value.action === 'submit' ? (value.values.allow === 'allow' ? 'allowed' : 'denied') : 'cancelled',
      ),
  };
}
function permissionsSummary(value: unknown): string {
  const permissions = record(value),
    network = record(permissions.network),
    fs = record(permissions.fileSystem);
  const paths = (list: unknown) => {
    const all = Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
    const shown = all.slice(0, 6).map((path) => (path.length > 120 ? `${path.slice(0, 117)}…（路径已截断）` : path));
    if (all.length > shown.length) shown.push(`另有 ${all.length - shown.length} 条路径未显示`);
    return shown;
  };
  const parts: string[] = [];
  if (network.enabled === true) parts.push('网络访问：允许');
  const read = paths(fs.read),
    write = paths(fs.write);
  if (read.length) parts.push(`文件读取：${read.join('、')}`);
  if (write.length) parts.push(`文件写入：${write.join('、')}`);
  if (Object.keys(permissions).length)
    return `实际授权范围：${parts.length ? parts.join('；') : '未声明网络或文件系统权限'}`;
  return '权限范围未提供；请按原生请求详情核对。';
}
