import path from 'node:path';
import { readNativeConfigSource } from '../../../native-management/config';
import type { McpAdapter, McpContext, McpSource } from '../../../native-management/mcp/mcp-types';
export const claudeMcp: McpAdapter = {
  sources: claudeMcpSources,
  format: 'json',
  transports: ['stdio', 'http', 'sse'],
  transportTag: 'explicit',
  urlFields: ['url'],
  headerField: 'headers',
  bearerField: null,
  enabledField: null,
};
async function claudeMcpSources(context: McpContext): Promise<McpSource[]> {
  const cwd = context.project?.dir ?? context.homeDir;
  const nativeHome = (process.platform === 'win32' ? context.env.USERPROFILE : context.env.HOME) || context.homeDir;
  const state = await readNativeConfigSource(
    path.resolve(cwd, context.env.CLAUDE_CONFIG_DIR || nativeHome, '.claude.json'),
    'user',
  );
  const sources: McpSource[] = [{ ...state, key: ['mcpServers'], label: 'Claude 用户配置', commandScope: 'user' }];
  if (context.project) {
    sources.push({
      ...state,
      scope: 'local',
      // Windows 的原生命令用正斜线写入 cwd 键，不匹配旧键或相近目录。
      key: ['projects', path.resolve(cwd).split(path.sep).join('/'), 'mcpServers'],
      label: 'Claude 个人项目配置',
      commandScope: 'local',
    });
    sources.push({
      ...(await readNativeConfigSource(path.join(context.project.dir, '.mcp.json'), 'project')),
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
    const managed = await readNativeConfigSource(path.join(managedRoot, name), 'managed');
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
