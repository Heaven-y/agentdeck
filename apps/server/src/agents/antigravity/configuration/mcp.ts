import path from 'node:path';
import { readNativeConfigSource } from '../../../native-management/config';
import type { McpAdapter, McpContext, McpSource } from '../../../native-management/mcp/mcp-types';
export const antigravityMcp: McpAdapter = {
  sources: antigravityMcpSources,
  format: 'json',
  transports: ['stdio', 'http'],
  transportTag: 'hint',
  urlFields: ['url', 'serverUrl'],
  headerField: 'headers',
  bearerField: null,
  enabledField: 'disabled',
};
async function antigravityMcpSources(context: McpContext): Promise<McpSource[]> {
  const sources: McpSource[] = [
    {
      ...(await readNativeConfigSource(path.join(context.homeDir, '.gemini/config/mcp_config.json'), 'user')),
      key: ['mcpServers'],
      label: 'Antigravity 全局 MCP',
    },
  ];
  if (context.project)
    sources.push({
      ...(await readNativeConfigSource(path.join(context.project.dir, '.agents/mcp_config.json'), 'project')),
      key: ['mcpServers'],
      label: '.agents/mcp_config.json',
    });
  return sources;
}
