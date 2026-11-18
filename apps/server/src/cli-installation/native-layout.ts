import path from 'node:path';
import { lstat, readdir, realpath } from 'node:fs/promises';
import type { CliInstallation } from './types';
import type { AgentKind } from '@agentdeck/shared/conversation';
import { BackendError, envValue, samePath, VERSION, type BackendContext } from './backend-support';
import { existing } from './protection';

export const unsafeLayout = () =>
  new BackendError('installation_changed', '无法确认原生入口或目标文件归属，请重新检查安装。');
const equal = (a: string, b: string) => samePath(a, b, 'win32');

// 安装树内的父目录必须保持原位。只对明确由安装器管理的末级链接单独放行。
export async function fixedDirectory(dir: string): Promise<boolean> {
  // Windows 临时目录可能使用 8.3 短名；逐层检查目录项以识别真实的重解析点。
  for (let cursor = path.resolve(dir); cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    if (!(await lstat(cursor)).isDirectory()) return false;
  }
  return true;
}
export function visibleNative(agent: AgentKind, env: NodeJS.ProcessEnv, context: BackendContext) {
  if (context.platform !== 'win32' || !['x64', 'arm64'].includes(context.arch)) return;
  if (agent === 'claude') return path.join(context.homeDir, '.local/bin/claude.exe');
  const local = envValue(env, 'LOCALAPPDATA');
  if (!local || !path.isAbsolute(local)) return;
  if (agent === 'antigravity') return path.join(local, 'agy/bin/agy.exe');
  const bin = envValue(env, 'CODEX_INSTALL_DIR') ?? path.join(local, 'Programs/OpenAI/Codex/bin');
  if (path.isAbsolute(bin)) return path.join(bin, 'codex.exe');
}
export function codexStore(context: BackendContext, env: NodeJS.ProcessEnv) {
  const home = envValue(env, 'CODEX_HOME') ?? path.join(context.homeDir, '.codex');
  if (!path.isAbsolute(home)) throw unsafeLayout();
  const root = path.join(home, 'packages/standalone');
  const target = context.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  return { root, target, releases: path.join(root, 'releases'), current: path.join(root, 'current') };
}
async function codexEntry(context: BackendContext, env: NodeJS.ProcessEnv, file: string) {
  const { releases, target, current } = codexStore(context, env);
  const bin = path.dirname(file);
  if (!(await fixedDirectory(releases)) || !(await fixedDirectory(path.dirname(bin)))) return false;
  if (!(await lstat(bin)).isSymbolicLink() || !(await lstat(current)).isSymbolicLink()) return false;
  const release = await realpath(current);
  const actualReleases = await realpath(releases);
  const name = path.basename(release);
  if (!equal(path.dirname(release), actualReleases) || !name.endsWith(`-${target}`)) return false;
  if (!VERSION.test(name.slice(0, -target.length - 1))) return false;
  const actual = await realpath(file);
  return ['bin/codex.exe', 'codex.exe'].some((entry) => equal(actual, path.join(release, entry)));
}
export function claudeVersions(context: BackendContext) {
  return path.join(context.homeDir, '.local/share/claude/versions');
}
export function versionFile(name: string) {
  return VERSION.test(name.replace(/\.exe$/i, ''));
}
async function claudeEntry(context: BackendContext, file: string) {
  if (!(await fixedDirectory(path.dirname(file)))) return false;
  const item = await lstat(file);
  if (item.isFile()) return true;
  const actual = await realpath(file);
  const versions = claudeVersions(context);
  return (
    item.isSymbolicLink() &&
    (await fixedDirectory(versions)) &&
    equal(path.dirname(actual), await realpath(versions)) &&
    versionFile(path.basename(actual))
  );
}
export async function isNativeEntry(context: BackendContext, env: NodeJS.ProcessEnv, agent: AgentKind, file: string) {
  const visible = visibleNative(agent, env, context);
  if (!visible || !equal(visible, file)) return false;
  try {
    if (agent === 'codex') return await codexEntry(context, env, file);
    if (agent === 'claude') return await claudeEntry(context, file);
    return (await fixedDirectory(path.dirname(file))) && (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

// 官方安装器会递归替换同名、不完整的 release。目录中有无法归属的条目时保留现场。
const codexFiles = new Set([
  'codex-package.json',
  'codex.exe',
  'bin/codex.exe',
  'bin/codex-code-mode-host.exe',
  'bin/codex-exec-server.exe',
  'codex-path/rg.exe',
  'codex-resources/rg.exe',
  'codex-resources/codex-command-runner.exe',
  'codex-resources/codex-windows-sandbox-setup.exe',
]);
export type ReleaseItem = { file: string; directory: boolean; identity: string };
export async function releaseItem(file: string): Promise<ReleaseItem> {
  const info = await lstat(file, { bigint: true });
  if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n)) throw unsafeLayout();
  const identity = [
    info.dev,
    info.ino,
    info.birthtimeNs,
    ...(info.isFile() ? [info.mtimeNs, info.ctimeNs, info.size] : []),
  ].join('/');
  return { file, directory: info.isDirectory(), identity };
}
// 按叶子在前的顺序记录已核实的目录项。清理时只使用这些路径，不递归删除新增内容。
export async function codexInventory(root: string, prefix = ''): Promise<ReleaseItem[]> {
  const dir = await releaseItem(path.resolve(root, prefix));
  if (!dir.directory) throw unsafeLayout();
  const items: ReleaseItem[] = [];
  for (const name of (await readdir(dir.file)).sort()) {
    const relative = prefix + name;
    if (['bin', 'codex-resources', 'codex-path'].includes(relative)) {
      items.push(...(await codexInventory(root, relative + '/')));
    } else {
      const item = await releaseItem(path.join(root, relative));
      if (item.directory || !codexFiles.has(relative)) throw unsafeLayout();
      items.push(item);
    }
  }
  return [...items, dir];
}
export async function codexProtection(
  context: BackendContext,
  installation: CliInstallation,
  env: NodeJS.ProcessEnv,
  version: string,
) {
  const { root, releases, target, current } = codexStore(context, env);
  const bin = path.dirname(installation.command!.command);
  const release = path.join(releases, `${version}-${target}`);
  const marker = path.join(root, 'auto-update-version');
  if ((await readdir(releases)).some((name) => name.toLowerCase().startsWith('.staging.'))) throw unsafeLayout();
  const info = await existing(release);
  if (info) {
    if (!info.isDirectory()) throw unsafeLayout();
    await codexInventory(release);
  }
  for (const file of [marker, path.join(root, 'install.lock')]) {
    const entry = await existing(file);
    if (entry && (!entry.isFile() || entry.nlink > 1)) throw unsafeLayout();
  }
  return { paths: [bin, current, release, marker], release };
}
