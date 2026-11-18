import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { BackendError, PACKAGES, samePath, type BackendContext } from './backend-support';
import { assertInstallationIdle } from './occupancy';
import { cleanupNotice, existing, removeOwnedTree, replaceFromStage } from './protection';
import { ownsNpmLaunchers } from './npm-source';
import { executeInstallation } from './installer';
import type { CliInstallation } from './types';

function layout(prefix: string, agent: 'claude' | 'codex', platform: NodeJS.Platform) {
  const windows = platform === 'win32';
  const bin = windows ? prefix : path.join(prefix, 'bin');
  const root = path.join(prefix, windows ? 'node_modules' : 'lib/node_modules', PACKAGES[agent]);
  return [root, ...(windows ? [agent, `${agent}.cmd`, `${agent}.ps1`] : [agent]).map((name) => path.join(bin, name))];
}

async function checkParents(prefix: string, targets: string[], platform: NodeJS.Platform) {
  const canonicalPrefix = await realpath(prefix);
  for (const file of targets) {
    let parent = path.dirname(file);
    while (!(await existing(parent))) parent = path.dirname(parent);
    const expected = path.join(canonicalPrefix, path.relative(prefix, parent));
    if (!samePath(await realpath(parent), expected, platform))
      throw new BackendError('installation_changed', 'CLI 安装目录指向其他位置，请重新检查。');
  }
}

export async function transactNpm(
  context: BackendContext,
  installation: CliInstallation,
  operation: { version: string; signal: AbortSignal; recheck: () => Promise<void>; verify: () => Promise<void> },
) {
  const { version, signal, recheck, verify } = operation;
  const { agent, prefix } = installation;
  if (!prefix || agent === 'antigravity') throw new BackendError('installation_unsupported', '无法确认 CLI 安装位置。');
  await mkdir(prefix, { recursive: true });
  // nvm 的逻辑 prefix 可被其它终端切换。事务的所有写入始终使用本次确认的物理位置。
  const physical = await realpath(prefix);
  const targets = layout(physical, agent, context.platform);
  const checkTarget = async () => {
    if (!samePath(await realpath(prefix), physical, context.platform))
      throw new BackendError('installation_changed', '全局安装目录已切换，请重新检查。');
    await checkParents(physical, targets, context.platform);
    if (!installation.installed && (await Promise.all(targets.map(existing))).some(Boolean))
      throw new BackendError('installation_changed', '安装位置已有文件，无法确认属于本次安装，已停止。');
    if (installation.installed && !(await ownsNpmLaunchers(targets[0]!, targets.slice(1), agent, context.platform)))
      throw new BackendError('installation_changed', '同名命令入口属于其他程序，已停止更新。');
    await assertInstallationIdle(context, targets, signal);
    signal.throwIfAborted();
  };
  await checkTarget();
  const stage = await mkdtemp(path.join(physical, '.agentdeck-stage-'));
  let notice: string | undefined;
  try {
    await executeInstallation(context, { ...installation, prefix: stage }, version, signal);
    const staged = layout(stage, agent, context.platform);
    await recheck();
    await checkTarget(); // 下载期间可能有人启动 CLI 或切换全局 Node。
    notice = await replaceFromStage(
      targets.map((target, i) => ({ target, staged: staged[i]! })),
      verify,
    );
  } finally {
    try {
      await removeOwnedTree(stage);
    } catch {
      notice = cleanupNotice;
    }
  }
  return notice;
}
