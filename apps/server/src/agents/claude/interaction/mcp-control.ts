import type { NativeMcpRuntimeState } from '@agentdeck/shared/settings';
import type { McpControl } from '../../../native-management/mcp/mcp-runtime';
import type { ClaudeQuery } from '../run/query';
import { claudeControl } from '../run/query';
import { NativeManagementError } from '../../../native-management/errors';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
const states: Record<string, NativeMcpRuntimeState> = {
  connected: 'connected',
  failed: 'failed',
  'needs-auth': 'authenticationRequired',
  pending: 'starting',
  disabled: 'disabled',
};
function summary(item: McpServerStatus | undefined) {
  if (!item) return { state: 'unknown' as const, auth: 'unknown', tools: [] };
  return {
    state: states[item.status] ?? 'unknown',
    auth: item.status === 'needs-auth' ? 'notLoggedIn' : 'unknown',
    tools: item.tools?.slice(0, 500).map((t) => t.name) ?? [],
  };
}
export function claudeMcpControl(query: ClaudeQuery, instanceId: string): McpControl {
  return {
    async status(name) {
      if (!query.mcpServerStatus) throw new NativeManagementError('unsupported_action');
      const item = (await claudeControl(query.mcpServerStatus())).find((r) => r.name === name);
      return {
        instanceId,
        name,
        ...summary(item),
        canReconnect: !!query.reconnectMcpServer,
        canToggle: !!query.toggleMcpServer,
        canLogin: false,
      };
    },
    async reconnect(name) {
      if (!query.reconnectMcpServer) throw new NativeManagementError('unsupported_action');
      await claudeControl(query.reconnectMcpServer(name));
    },
    async toggle(name, enabled) {
      if (!query.toggleMcpServer) throw new NativeManagementError('unsupported_action');
      await claudeControl(query.toggleMcpServer(name, enabled));
    },
  };
}
