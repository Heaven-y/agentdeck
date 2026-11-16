import { lazy } from 'react';
import { SquareTerminal } from 'lucide-react';
import type { BuiltinPluginRegistration } from '../../features/plugins/builtin-contracts';
export const sshConsoleRegistration: BuiltinPluginRegistration = {
  id: 'ssh-console',
  Page: lazy(() => import('./Workspace')),
  Icon: SquareTerminal,
  priority: 100,
  disableConfirmation: (plugin) =>
    `停用“${plugin.manifest.name}”会关闭它的控制台与其中打开的终端。服务器档案与保存的凭据保留，重新启用后可继续使用。继续吗？`,
  // 页面状态都在组件内，停用后随卸载一起释放；服务器档案与凭据留在后端。
  onDisabled() {},
};
