import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentKind } from '@agentdeck/shared/conversation';
import { resolveLocalCommand } from '../../platform/process/executable';
import { runProcess } from '../../platform/process/run';
import { resolveCodexCommand } from '../codex/launch';
export async function nativeVersion(
  agent: AgentKind,
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const command =
    agent === 'codex'
      ? await resolveCodexCommand({ env })
      : resolveLocalCommand(agent === 'antigravity' ? 'agy' : 'claude', env);
  const result = await runProcess(command.command, [...command.args, '--version'], {
    cwd,
    env,
    signal,
    timeoutMs: 5000,
    outputCap: 64 * 1024,
  });
  return result.exitCode === 0 ? result.stdout.toString('utf8').match(/\b\d+\.\d+\.\d+\b/)?.[0] : undefined;
}
export async function claudeSdkVersion(): Promise<string | undefined> {
  const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const pkg = JSON.parse(await readFile(path.join(path.dirname(entry), 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  return typeof pkg.version === 'string' ? pkg.version : undefined;
}
