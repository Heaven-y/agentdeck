import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { inspectDirectory } from '../../../platform/files/safe-file';
import type { ResourceContext, ResourceTarget } from '../../common/configuration/resources';

function skillPluginDirectory(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return;
  const parts = relative.split(path.sep);
  if (parts.length < 2) return;
  return path.join(root, parts[0]!);
}
async function hasPluginMarker(directory: string): Promise<boolean> {
  try {
    const marker = path.join(directory, '.claude-plugin/plugin.json');
    if (!(await inspectDirectory(path.dirname(marker)))) return false;
    return !!(await lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }));
  } catch {
    return true;
  }
}
/** 技能目录内的 @skills-dir 插件同样是插件资产；只检查标记，不加载或执行插件。 */
export async function protectClaudePluginResource(
  context: ResourceContext,
  target: ResourceTarget,
): Promise<ResourceTarget> {
  if (context.agent !== 'claude') return target;
  const roots = [path.join(context.env.CLAUDE_CONFIG_DIR || path.join(context.homeDir, '.claude'), 'skills')];
  if (context.project) roots.push(path.join(context.project.dir, '.claude/skills'));
  for (const root of roots) {
    const directory = skillPluginDirectory(root, target.file);
    if (directory && (await hasPluginMarker(directory)))
      return {
        ...target,
        readOnly: true,
        owner: { kind: 'plugin', name: path.basename(directory) },
        description: '此文件属于本地原生插件，请通过所属插件管理；此入口只读。',
      };
  }
  return target;
}
