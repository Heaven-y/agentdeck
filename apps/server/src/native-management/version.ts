import type { ResourceContext } from '../agents/common/configuration/resources';
import type { ResolvedCommand } from '../platform/process/executable';
import { runProcess } from '../platform/process/run';

/** 文件格式存在不代表当前 CLI 支持，只为适配器已核实的版本开放状态写入。 */
export async function verifiedSkillVersion(
  context: ResourceContext,
  version: string,
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
    return result.exitCode === 0 && result.stdout.toString('utf8').match(/\b\d+\.\d+\.\d+[\w.+-]*/)?.[0] === version;
  } catch {
    return false;
  }
}
