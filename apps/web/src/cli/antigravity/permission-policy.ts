import type { PermissionChoice } from '../shared/permission-choice';

export const antigravityPermissions: PermissionChoice[] = [
  {
    label: '接受编辑',
    description: '按 Antigravity 的编辑模式处理工具审批',
    selection: { agent: 'antigravity', mode: 'accept-edits' },
  },
  {
    label: '自动模式',
    description: '自动处理编辑和安全命令，高风险操作仍需批准',
    selection: { agent: 'antigravity', mode: 'auto' },
  },
  {
    label: '计划模式',
    description: '按 Antigravity 的计划模式处理工具审批',
    selection: { agent: 'antigravity', mode: 'plan' },
  },
  {
    label: '跳过权限检查',
    description: '自动允许原生工具权限请求',
    selection: { agent: 'antigravity', mode: 'bypass' },
  },
];
