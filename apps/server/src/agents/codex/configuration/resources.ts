import { projectBase, userBase, type Builder, type ResourceContext } from '../../common/configuration/resources';
export function codexPlan(context: ResourceContext, output: Builder) {
  const user = userBase(context, '.codex', context.env.CODEX_HOME);
  output.file(
    user,
    'config.toml',
    'settings',
    'Codex 用户配置：MCP、模型、权限、插件和代理角色（agents）。config_file 路径相对声明它的配置文件解析。',
  );
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) output.file(user, name, 'rules');
  output.scan(user, 'rules', 'policy');
  output.file(user, 'hooks.json', 'hooks', 'Hooks 配置，需要当前版本支持并启用 features.hooks。');
  output.scan(user, 'agents', 'agent-configs');
  output.scan(userBase(context, '.agents'), 'skills', 'skills', true);
  output.scan({ ...user, readOnly: true }, 'skills', 'skills');
  const project = projectBase(context);
  if (project) {
    output.file(project, '.codex/config.toml', 'settings', '项目配置（含代理角色），在项目获 Codex 信任后加载。');
    for (const name of ['AGENTS.md', 'AGENTS.override.md']) output.file(project, name, 'rules');
    output.scan(project, '.codex/rules', 'policy');
    output.file(project, '.codex/hooks.json', 'hooks', '受信任项目的 Hooks 配置。');
    output.scan(project, '.codex/agents', 'agent-configs');
    output.scan(project, '.agents/skills', 'skills', true);
  }
  output.plan.guidance.push(
    {
      label: 'Codex MCP',
      description: 'MCP 位于对应 config.toml 的 mcp_servers 表；也可通过原生命令管理。',
      command: 'codex mcp --help',
    },
    {
      label: 'Codex 原生插件',
      description: '通过原生插件管理器维护；插件缓存不直接编辑，清单命令可能访问 marketplace。',
      command: 'codex plugin --help',
    },
    {
      label: '命令规则',
      description:
        '.rules 使用 Starlark；此编辑器只检查 UTF-8 与文件大小，规则语法由原生 CLI 验证，修改后需下次启动加载。',
    },
  );
}
