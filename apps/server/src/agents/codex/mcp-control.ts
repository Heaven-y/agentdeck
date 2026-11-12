import type { NativeMcpRuntimeState } from '@agentdeck/shared/settings';
import type { McpControl } from '../../native-management/mcp-runtime';
import { record, text, type RecordValue } from './types';
const states: NativeMcpRuntimeState[] = [
  'notStarted',
  'starting',
  'connected',
  'authenticationRequired',
  'failed',
  'cancelled',
  'disabled',
];
function runtimeState(item: RecordValue): NativeMcpRuntimeState {
  if (states.includes(item.runtimeStatus as NativeMcpRuntimeState)) return item.runtimeStatus as NativeMcpRuntimeState;
  return item.toolsError ? 'failed' : 'unknown';
}
export function codexMcpControl(
  client: { request(method: string, params: RecordValue): Promise<RecordValue> },
  instanceId: string,
  sessionId: () => string | undefined,
): McpControl {
  return {
    async status(name, cursor) {
      const response = await client.request('mcpServerStatus/list', {
        threadId: sessionId() ?? null,
        serverName: name,
        detail: 'toolsAndAuthOnly',
        cursor: cursor ?? null,
        limit: 20,
      });
      const rows = Array.isArray(response.data) ? response.data : [];
      const item = record(rows.find((r) => record(r).name === name));
      return {
        instanceId,
        name,
        state: runtimeState(item),
        auth: ['unknown', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(text(item.authStatus))
          ? text(item.authStatus)
          : 'unknown',
        tools: Object.keys(record(item.tools)).slice(0, 500),
        ...(typeof response.nextCursor === 'string' ? { nextCursor: response.nextCursor } : {}),
        canReconnect: true,
        canToggle: false,
        canLogin: item.authStatus !== 'unsupported',
      };
    },
    async reconnect() {
      await client.request('config/mcpServer/reload', {});
    },
  };
}
