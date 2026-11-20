import type { PermissionChoice } from '../shared/permission-choice';

export const claudePermissions: PermissionChoice[] = [
  { label: '手动审批', description: '由你回答原生权限请求', selection: { agent: 'claude', mode: 'default' } },
  {
    label: '接受编辑',
    description: '自动接受文件编辑，其他请求仍按原生规则处理',
    selection: { agent: 'claude', mode: 'acceptEdits' },
  },
  {
    label: '自动审查',
    description: '由 Claude 自动审查操作是否可以执行',
    selection: { agent: 'claude', mode: 'auto' },
  },
  { label: '计划模式', description: '探索与规划，不直接编辑源文件', selection: { agent: 'claude', mode: 'plan' } },
  { label: '不询问', description: '拒绝需要你批准的操作', selection: { agent: 'claude', mode: 'dontAsk' } },
  {
    label: '跳过权限检查',
    description: '自动允许工具操作，不再询问权限',
    selection: { agent: 'claude', mode: 'bypassPermissions' },
  },
];
