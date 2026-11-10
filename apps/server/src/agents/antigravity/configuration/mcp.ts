import path from 'node:path';
import { readSkillConfig } from '../../../native-management/config';
import type { McpContext, McpSource } from '../../../native-management/mcp-types';
export async function antigravityMcpSources(context: McpContext): Promise<McpSource[]> {
  const sources: McpSource[] = [
    {
      ...(await readSkillConfig(path.join(context.homeDir, '.gemini/config/mcp_config.json'), 'user')),
      key: ['mcpServers'],
      label: 'Antigravity 全局 MCP',
    },
  ];
  if (context.project)
    sources.push({
      ...(await readSkillConfig(path.join(context.project.dir, '.agents/mcp_config.json'), 'project')),
      key: ['mcpServers'],
      label: '.agents/mcp_config.json',
    });
  return sources;
}
