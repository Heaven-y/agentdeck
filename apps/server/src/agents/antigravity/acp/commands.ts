import { capabilityId, type NativeCapabilityCatalog } from '../../capability-types';
import type { DiscoveryProfile } from '../models/discovery-profile';
import { AntigravityAcpClient } from './client';
import { AcpError, list, object, text, type AcpConnection, type AcpRecord } from './types';

const supported = new Map([
  ['compact', '压缩当前会话'],
  ['plan', '规划任务'],
  ['grill-me', '通过提问明确目标'],
  ['learn', '总结可复用经验'],
  ['browser', '调用原生浏览器代理'],
  ['goal', '持续完成目标'],
]);
export function acpCommandEntries(values: unknown[]): NativeCapabilityCatalog['entries'] {
  return values.slice(0, 256).flatMap((value) => {
    const name = text(object(value).name),
      description = supported.get(name);
    if (!description && name !== 'schedule') return [];
    return [
      {
        id: capabilityId('antigravity', 'acp-command', name),
        kind: 'command' as const,
        name,
        description: description ?? '原生定时任务',
        source: 'Antigravity ACP',
        available: !!description,
        unavailableReason: description ? undefined : '定时任务需要持续运行的原生调度器，请在原生CLI中管理。',
        requiresSession: name === 'compact',
        supportsArguments: name !== 'compact',
        ...(description ? { invocation: { kind: 'acp-command' as const, name } } : {}),
      },
    ];
  });
}
/** new/resume完成前就会收到目录；保留有界的会话目录，发送前核对实际会话。 */
export class AcpCommands {
  private readonly sessions = new Map<string, unknown[]>();
  private readonly listeners = new Set<() => void>();
  update(params: AcpRecord): void {
    const update = object(params.update),
      id = text(params.sessionId);
    if (update.sessionUpdate !== 'available_commands_update' || !id) return;
    if (!this.sessions.has(id) && this.sessions.size >= 2) return;
    this.sessions.set(id, list(update.availableCommands).slice(0, 256));
    for (const listener of this.listeners) listener();
  }
  entries(id: string) {
    return acpCommandEntries(this.sessions.get(id) ?? []);
  }
  async ready(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.sessions.has(id)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
        signal?.removeEventListener('abort', abort);
      };
      const check = () => {
        if (this.sessions.has(id)) {
          cleanup();
          resolve();
        }
      };
      const abort = () => {
        cleanup();
        reject(new AcpError('selection', 'ACP命令目录读取已取消。'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new AcpError('selection', 'Antigravity 命令列表尚未就绪，请稍后重试。'));
      }, 5000);
      this.listeners.add(check);
      signal?.addEventListener('abort', abort, { once: true });
      check();
    });
  }
  input(id: string, name: string, argumentsText: string): string {
    const entry = this.entries(id).find((item) => item.name === name && item.available);
    if (!entry || (!entry.supportsArguments && argumentsText.trim()))
      throw new AcpError('selection', '此ACP命令已不可用或不支持参数，请刷新目录后重试。');
    return `/${name}${argumentsText.trim() ? ` ${argumentsText.trim()}` : ''}`;
  }
}
/** 仅在无用户配置、无网络的发现profile中读取目录；不发送模型输入。 */
export async function discoverAcpCommands(profile: DiscoveryProfile, signal?: AbortSignal) {
  const client = await AntigravityAcpClient.start({ cwd: profile.root, env: profile.env });
  const commands = new AcpCommands();
  client.onNotification = (method, params) => {
    if (method === 'session/update') commands.update(params);
  };
  let sessionId = '';
  try {
    await client.request(
      'initialize',
      { protocolVersion: 1, clientInfo: { name: 'agentdeck', version: '0.1.1' }, clientCapabilities: {} },
      { signal },
    );
    await client.request('authenticate', { methodId: 'gemini-api-key' }, { signal });
    const response = await client.request('session/new', { cwd: profile.root, mcpServers: [] }, { signal });
    sessionId = text(response.sessionId);
    await commands.ready(sessionId, signal);
    return commands.entries(sessionId);
  } catch {
    signal?.throwIfAborted();
    return [];
  } finally {
    // 只读探测建出的会话必须在原生侧关掉，否则它以空会话留在列表里，打开时无轨迹可读。
    await closeProbeSession(client, sessionId);
    await client.close();
  }
}

async function closeProbeSession(client: AcpConnection, sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await client.request('session/close', { sessionId });
  } catch {
    // 关会话失败不影响目录结果；客户端关闭仍会带走子进程。
  }
}
