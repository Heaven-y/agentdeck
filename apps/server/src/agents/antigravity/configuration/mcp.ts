import path from 'node:path';
import { readNativeConfigSource } from '../../../native-management/config';
import type { McpContext, McpSource } from '../../../native-management/mcp/mcp-types';
export async function antigravityMcpSources(context: McpContext): Promise<McpSource[]> {
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
