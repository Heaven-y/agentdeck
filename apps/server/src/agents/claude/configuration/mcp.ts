import path from 'node:path';
import { readSkillConfig } from '../../../native-management/config';
import type { McpContext, McpSource } from '../../../native-management/mcp-types';
export async function claudeMcpSources(context: McpContext): Promise<McpSource[]> {
  const state = await readSkillConfig(
    path.resolve(context.env.CLAUDE_CONFIG_DIR || context.homeDir, '.claude.json'),
    'user',
  );
  const sources: McpSource[] = [{ ...state, key: ['mcpServers'], label: 'Claude 用户配置', commandScope: 'user' }];
  if (context.project) {
    sources.push({
      ...state,
      scope: 'local',
      key: ['projects', context.project.dir.replace(/\\/g, '/'), 'mcpServers'],
      label: 'Claude 个人项目配置',
      commandScope: 'local',
    });
    // 旧 Windows 原生记录可能使用反斜线；只匹配当前项目的准确键。
    const projects = state.data.projects as Record<string, unknown> | undefined;
    if (projects && Object.hasOwn(projects, context.project.dir)) sources.at(-1)!.key[1] = context.project.dir;
    sources.push({
      ...(await readSkillConfig(path.join(context.project.dir, '.mcp.json'), 'project')),
      key: ['mcpServers'],
      label: '.mcp.json',
    });
  }
  sources.push(...(await managedSources(context)));
  return sources;
}
async function managedSources(context: McpContext): Promise<McpSource[]> {
  const sources: McpSource[] = [];
  const managedRoot =
    process.platform === 'win32'
      ? path.join(context.env.ProgramFiles || 'C:/Program Files', 'ClaudeCode')
      : process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode'
        : '/etc/claude-code';
  for (const name of ['managed-mcp.json', 'managed-settings.json']) {
    const managed = await readSkillConfig(path.join(managedRoot, name), 'managed');
    if (managed.revision !== 'missing')
      sources.push({
        ...managed,
        key: [name === 'managed-mcp.json' ? 'mcpServers' : 'managedMcpServers'],
        label: name,
        readOnly: true,
      });
  }
  return sources;
}
