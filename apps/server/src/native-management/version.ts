import type { ResourceContext } from '../agents/common/configuration/resources';
import type { ResolvedCommand } from '../platform/process/executable';
import { runProcess } from '../platform/process/run';

/** 文件格式存在不代表当前 CLI 支持，只为适配器已核实的版本开放状态写入。 */
export async function verifiedSkillVersion(
  context: ResourceContext,
  baseline: readonly [number, number, number],
  resolve: (env: NodeJS.ProcessEnv) => ResolvedCommand | Promise<ResolvedCommand>,
): Promise<boolean> {
  try {
    const command = await resolve(context.env);
    const result = await runProcess(command.command, [...command.args, '--version'], {
      cwd: context.project?.dir ?? context.homeDir,
      env: context.env,
      timeoutMs: 5000,
      outputCap: 64 * 1024,
    });
    const match = result.stdout.toString('utf8').match(/\b(\d+)\.(\d+)\.(\d+)(?![\w.+-])/);
    if (result.exitCode !== 0 || !match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    // 仅限已验证的配置系列；下一主版本或次版本须重新核对文件格式。
    return major === baseline[0] && minor === baseline[1] && patch! >= baseline[2];
  } catch {
    return false;
  }
}
