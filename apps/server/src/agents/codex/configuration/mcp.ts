import path from 'node:path';
import { readSkillConfig } from '../../../native-management/config';
import type { McpContext, McpSource } from '../../../native-management/mcp-types';
export async function codexMcpSources(context: McpContext): Promise<McpSource[]> {
  const sources: McpSource[] = [
    {
      ...(await readSkillConfig(
        path.join(context.env.CODEX_HOME || path.join(context.homeDir, '.codex'), 'config.toml'),
        'user',
      )),
      key: ['mcp_servers'],
      label: 'Codex 用户 config.toml',
    },
  ];
  if (context.project)
    sources.push({
      ...(await readSkillConfig(path.join(context.project.dir, '.codex/config.toml'), 'project')),
      key: ['mcp_servers'],
      label: '.codex/config.toml（是否加载由原生信任决定）',
    });
  return sources;
}
