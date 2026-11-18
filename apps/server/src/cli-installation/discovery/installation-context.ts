import { homedir } from 'node:os';
import { resolveLocalCommand } from '../../platform/process/executable';
import { runProcess } from '../../platform/process/run';
import { runInstallationProcess } from '../transaction/installation-process';
import { BackendError, type BackendContext, type BackendOptions } from '../backend-support';
import { inspectInstallation } from './discovery';
import type { CliInstallation } from '../types';

export function installationContext(options: BackendOptions): BackendContext {
  return {
    environment: options.environment ?? (() => Promise.resolve(process.env)),
    run: options.run ?? runProcess,
    operationRun: options.run ?? runInstallationProcess,
    fetch: options.fetch ?? globalThis.fetch,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    homeDir: options.homeDir ?? homedir(),
    resolveCommand: options.resolveCommand ?? resolveLocalCommand,
  };
}

export async function checkedInstallation(context: BackendContext, installation: CliInstallation, signal: AbortSignal) {
  const current = await inspectInstallation(context, installation.agent, signal);
  if (current.identity !== installation.identity)
    throw new BackendError('installation_changed', 'CLI 安装路径、版本或更新配置已变化，请重新检查。');
  if (current.installed ? !(current.canUpdate || current.canRepair) : !current.canInstall)
    throw new BackendError('installation_unsupported', current.message ?? '无法安全操作当前 CLI，请查看官方指引。');
  return current;
}
