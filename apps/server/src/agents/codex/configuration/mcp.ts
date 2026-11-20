import path from 'node:path';
import { readNativeConfigSource } from '../../../native-management/config';
import type { McpAdapter, McpContext, McpSource } from '../../../native-management/mcp/mcp-types';
export const codexMcp: McpAdapter = {
  sources: codexMcpSources,
  format: 'toml',
  transports: ['stdio', 'http'],
  acceptsTransport: acceptsCodexMcpTransport,
  urlFields: ['url'],
  headerField: 'http_headers',
  bearerField: 'bearer_token_env_var',
  enabledField: 'enabled',
};
// Codex 按字段推断传输，不读取 type。另一种传输的专属字段即使为空也会使配置无效。
const stdioFields = ['command', 'args', 'env', 'env_vars', 'cwd'];
const httpFields = [
  'url',
  'bearer_token_env_var',
  'http_headers',
  'env_http_headers',
  'auth',
  'http_command',
  'http_args',
  'http_env',
  'http_env_vars',
  'http_cwd',
];
function acceptsCodexMcpTransport(config: Record<string, unknown>, transport: 'stdio' | 'http' | 'sse'): boolean {
  return !(transport === 'stdio' ? httpFields : stdioFields).some((key) => Object.hasOwn(config, key));
}
async function codexMcpSources(context: McpContext): Promise<McpSource[]> {
  const cwd = context.project?.dir ?? context.homeDir;
  const sources: McpSource[] = [
    {
      ...(await readNativeConfigSource(
        path.resolve(cwd, context.env.CODEX_HOME || path.join(context.homeDir, '.codex'), 'config.toml'),
        'user',
      )),
      key: ['mcp_servers'],
      label: 'Codex 用户 config.toml',
    },
  ];
  if (context.project)
    sources.push({
      ...(await readNativeConfigSource(path.join(context.project.dir, '.codex/config.toml'), 'project')),
      key: ['mcp_servers'],
      label: '.codex/config.toml（是否加载由原生信任决定）',
    });
  return sources;
}
