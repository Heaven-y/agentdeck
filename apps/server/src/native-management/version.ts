import type { ResourceContext } from '../agents/common/configuration/resources';
import { resolveLocalCommand } from '../platform/process/executable';
import { runProcess } from '../platform/process/run';
import { resolveCodexCommand } from '../agents/codex/run/launch';

const versions = { claude: '2.1.317', codex: '0.166.0', antigravity: '1.5.3' };
/** 文件格式存在不代表当前 CLI 支持；只为已核实版本开放结构化状态写入。 */
export async function verifiedSkillVersion(context: ResourceContext): Promise<boolean> {
  try {
    const command =
      context.agent === 'codex'
        ? await resolveCodexCommand({ env: context.env })
        : resolveLocalCommand(context.agent === 'antigravity' ? 'agy' : 'claude', context.env);
    const result = await runProcess(command.command, [...command.args, '--version'], {
      cwd: context.project?.dir ?? context.homeDir,
      env: context.env,
      timeoutMs: 5000,
      outputCap: 64 * 1024,
    });
    return (
      result.exitCode === 0 &&
      result.stdout.toString('utf8').match(/\b\d+\.\d+\.\d+\b/)?.[0] === versions[context.agent]
    );
  } catch {
    return false;
  }
}
