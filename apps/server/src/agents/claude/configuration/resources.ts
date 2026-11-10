import {
  projectBase,
  userBase,
  type Base,
  type Builder,
  type ResourceContext,
} from '../../common/configuration/resources';
import path from 'node:path';
export function claudePlan(context: ResourceContext, output: Builder) {
  const user = userBase(context, '.claude', context.env.CLAUDE_CONFIG_DIR);
  output.file(user, 'settings.json', 'settings', 'Claude 用户设置，含权限、环境和原生插件选择；保留未知字段。');
  output.file(user, 'CLAUDE.md', 'rules');
  output.scan(user, 'rules', 'rules', true);
  output.scan(user, 'skills', 'skills', true);
  output.scan({ ...user, readOnly: true }, 'skills/synced', 'skills');
  const managedDirectory =
    process.platform === 'win32'
      ? path.join(context.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
      : process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode'
        : '/etc/claude-code';
  const managed: Base = {
    directory: managedDirectory,
    displayPath: managedDirectory,
    scope: 'managed',
    readOnly: true,
  };
  output.scan(managed, '.claude/skills', 'skills');
  output.scan(managed, '.claude/agents', 'agents');
  output.file(managed, 'managed-settings.json', 'settings', '管理员下发的原生策略，仅显示原文，不覆盖托管配置。');
  output.scan(user, 'agents', 'agents', true);
  output.file(user, 'settings.json', 'hooks', 'Claude Hooks 位于此原生设置的 hooks 字段；保存不执行命令。');
  const project = projectBase(context);
  if (project) {
    const local: Base = { ...project, scope: 'local' };
    output.file(project, '.claude/settings.json', 'settings', '项目共享设置；原生 user、project、local 层保持独立。');
    output.file(local, '.claude/settings.local.json', 'settings', '仅本机使用的项目设置，通常不提交版本控制。');
    for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) output.file(project, name, 'rules');
    output.file(local, 'CLAUDE.local.md', 'rules', '个人项目规则，保留 Claude 原生 local 作用域。');
    output.file(
      project,
      'AGENTS.md',
      'rules',
      '新版本 Claude 的条件回退入口；是否加载由原生版本与已有 CLAUDE 文件决定。',
    );
    output.file(project, '.mcp.json', 'mcp', '项目 MCP 配置；是否启动或批准服务器仍由 Claude 决定。');
    output.scan(project, '.claude/rules', 'rules', true);
    output.scan(project, '.claude/skills', 'skills', true);
    output.scan(project, '.claude/agents', 'agents', true);
    output.file(project, '.claude/settings.json', 'hooks', '项目 Hooks 原文入口；执行、权限与加载由 Claude 决定。');
    output.file(local, '.claude/settings.local.json', 'hooks', '个人项目 Hooks 原文入口。');
  }
  output.plan.guidance.push(
    {
      label: '用户与个人项目 MCP',
      description: '原生保存在混合状态文件中，请使用 CLI 管理。list/get 可能连接已批准的服务器。',
      command: 'claude mcp --help',
    },
    {
      label: 'Claude 原生插件',
      description: '原生支持 user、project、local 作用域；安装缓存不作为配置文件编辑。',
      command: 'claude plugin --help',
    },
  );
}
