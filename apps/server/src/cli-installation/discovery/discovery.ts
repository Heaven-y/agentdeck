import { cliExecutables } from '../../agents/common/executables';
import path from 'node:path';
import type { AgentKind } from '@agentdeck/shared/conversation';
import type { ResolvedCommand } from '../../platform/process/executable';
import type { CliInstallation } from '../types';
import {
  commandFingerprint,
  envValue,
  GUIDES,
  hash,
  installationEnvironment,
  pathDirectories,
  samePath,
  VERSION,
  type BackendContext,
} from '../backend-support';
import {
  brokenNpmPackage,
  discoverNpm,
  npmBinDirectory,
  officialNpmSource,
  type NpmInstallation,
  type OfficialPackage,
} from '../npm/npm-source';
import { isNativeEntry } from '../native/native-layout';
import { hardlinkFingerprint } from '../native/native-binary';
import { nativeRepairIdentity } from '../native/native-history';
import { applyClaudePolicy, claudePolicy } from '../native/claude-policy';

async function currentVersion(
  command: ResolvedCommand,
  input: { context: BackendContext; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<string | null> {
  try {
    const env = { ...input.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', DISABLE_AUTOUPDATER: '1' };
    const result = await input.context.run(command.command, [...command.args, '--version'], {
      env,
      signal: input.signal,
      timeoutMs: 5_000,
      outputCap: 16 * 1024,
    });
    if (result.exitCode !== 0) return null;
    const version = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`
      .trim()
      .match(
        /^(?:codex-cli\s+|agy(?:\s+version)?\s+|Antigravity(?: CLI)?\s+)?v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)(?:\s|$)/i,
      )?.[1];
    return version && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

function explicitPath(agent: AgentKind, env: NodeJS.ProcessEnv): string | undefined {
  if (agent === 'claude') return envValue(env, 'CLAUDE_CODE_EXECUTABLE');
  if (agent === 'codex') return envValue(env, 'AGENTDECK_CODEX');
  return undefined;
}

function pathIncludes(dir: string, env: NodeJS.ProcessEnv, context: BackendContext): boolean {
  return pathDirectories(env, context.platform).some((entry) => samePath(entry, dir, context.platform));
}

type Capability = { allowed: boolean; message: string | null };
function codexInstallCapability(env: NodeJS.ProcessEnv, context: BackendContext): Capability {
  const local = envValue(env, 'LOCALAPPDATA');
  if (!local) return { allowed: false, message: '缺少本机安装目录，请按官方指引安装。' };
  const custom = envValue(env, 'CODEX_INSTALL_DIR');
  const known = path.join(local, 'Programs/OpenAI/Codex/bin');
  if (!custom || samePath(custom, known, context.platform) || pathIncludes(custom, env, context))
    return { allowed: true, message: null };
  return { allowed: false, message: 'Codex 自定义安装目录不在当前启动路径中，请先调整 PATH 并重启工作台。' };
}
function missingNativeCapability(agent: AgentKind, env: NodeJS.ProcessEnv, context: BackendContext): Capability {
  if (context.platform !== 'win32' || !['x64', 'arm64'].includes(context.arch))
    return { allowed: false, message: '当前平台的原生安装暂未适配，请按官方指引安装。' };
  if (agent === 'antigravity')
    return {
      allowed: !!envValue(env, 'LOCALAPPDATA'),
      message: envValue(env, 'LOCALAPPDATA') ? null : '缺少本机安装目录，请按官方指引安装。',
    };
  if (agent === 'codex') return codexInstallCapability(env, context);
  return { allowed: true, message: null };
}

function discoverableNpmDirectory(npm: NpmInstallation, env: NodeJS.ProcessEnv, context: BackendContext): boolean {
  const dir = npmBinDirectory(npm, context.platform);
  if (pathIncludes(dir, env, context)) return true;
  const appData = envValue(env, 'APPDATA');
  return context.platform === 'win32' && !!appData && samePath(dir, path.join(appData, 'npm'), context.platform);
}

function missingCapability(input: {
  agent: AgentKind;
  npm?: NpmInstallation;
  env: NodeJS.ProcessEnv;
  context: BackendContext;
}): Capability {
  const { agent, npm, env, context } = input;
  if (explicitPath(agent, env)) return { allowed: false, message: '显式指定的 CLI 启动路径不可用；请先修正该路径。' };
  if (!npm || agent === 'antigravity') return missingNativeCapability(agent, env, context);
  const allowed = discoverableNpmDirectory(npm, env, context);
  return { allowed, message: allowed ? null : 'npm 全局命令目录不在当前启动路径中，请先调整 PATH 并重启工作台。' };
}

async function installedSource(
  installation: CliInstallation,
  input: { context: BackendContext; env: NodeJS.ProcessEnv; signal?: AbortSignal; npm?: NpmInstallation },
): Promise<OfficialPackage | undefined> {
  const command = installation.command!;
  const { context, env, npm, signal } = input;
  installation.version = await currentVersion(command, { context, env, signal });
  const info = npm ? await officialNpmSource({ agent: installation.agent, command, npm, context }) : undefined;
  if (info) installation.source = 'npm';
  else if (!command.args.length && (await isNativeEntry(context, env, installation.agent, command.command)))
    installation.source = 'native';
  installation.canRepair =
    installation.version === null && (info !== undefined || (await nativeRepairIdentity(context, installation, env)));
  applyUpdateCapability(installation, info);
  return info;
}

function applyUpdateCapability(installation: CliInstallation, info?: OfficialPackage) {
  installation.canUpdate = installation.source !== 'unknown' && installation.version !== null;
  if (installation.version !== null && info && info.version !== installation.version) {
    installation.canRepair = true;
    installation.canUpdate = false;
    installation.message = 'npm 包清单与实际程序版本不一致，可修复此安装。';
    return;
  }
  if (installation.canRepair) installation.message = '无法读取程序版本，安装可能已损坏，可修复此安装。';
  if (!installation.canUpdate && !installation.canRepair)
    installation.message = '无法确认 CLI 的官方安装来源或当前版本；请使用原安装方式更新。';
}

function attachNpm(installation: CliInstallation, npm?: NpmInstallation): void {
  if (!npm || (installation.installed && installation.source !== 'npm')) return;
  installation.npm = npm.command;
  installation.prefix = npm.prefix;
}

async function discoverMissing(
  installation: CliInstallation,
  input: { context: BackendContext; env: NodeJS.ProcessEnv; npm?: NpmInstallation },
) {
  const { context, env, npm } = input;
  const agent = installation.agent;
  const info = !explicitPath(agent, env) ? await brokenNpmPackage(agent, npm, context) : undefined;
  if (info) {
    installation.installed = true;
    installation.source = 'npm';
    installation.canRepair = true;
    installation.message = '已找到 npm 包，但启动入口缺失或损坏，可修复此安装。';
  } else {
    const capability = missingCapability({ agent, ...input });
    installation.canInstall = capability.allowed;
    installation.message = capability.message;
  }
  return info;
}

export async function inspectInstallation(
  context: BackendContext,
  agent: AgentKind,
  signal?: AbortSignal,
): Promise<CliInstallation> {
  const inherited = await context.environment(agent);
  const env = installationEnvironment(inherited);
  const settings = agent === 'claude' ? await claudePolicy(env, context) : undefined;
  let command: ResolvedCommand | undefined;
  try {
    command = context.resolveCommand(cliExecutables[agent], inherited);
  } catch {
    /* 缺失或显式路径无效。 */
  }
  const npm = agent === 'antigravity' ? undefined : await discoverNpm(context, env, signal);
  const installation: CliInstallation = {
    agent,
    installed: !!command,
    version: null,
    source: command ? 'unknown' : 'missing',
    identity: '',
    command,
    canInstall: false,
    canUpdate: false,
    message: null,
    guideUrl: GUIDES[agent],
  };
  const packageIdentity = command
    ? await installedSource(installation, { context, env, signal, npm })
    : await discoverMissing(installation, { context, env: inherited, npm });
  attachNpm(installation, npm);
  if (settings) applyClaudePolicy(installation, settings);
  installation.identity = hash({
    installation,
    files: (await hardlinkFingerprint(installation, signal)) ?? (await commandFingerprint(command)),
    packageIdentity,
    npm: npm?.identity,
    settings: settings?.identity,
    environment: env,
    override: explicitPath(agent, inherited),
    platform: context.platform,
    arch: context.arch,
  });
  return installation;
}
