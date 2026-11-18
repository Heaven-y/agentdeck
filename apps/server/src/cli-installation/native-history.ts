import { createReadStream } from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { envValue, type BackendContext } from './backend-support';
import type { CliInstallation } from './types';
import { assertInstallationIdle } from './occupancy';
import { fixedDirectory } from './native-layout';

// Get-AuthenticodeSignature 可按扩展名选择签名提供程序；.old 必须用 PE 格式验证。
// WinVerifyTrust 的 PE provider 支持按内容识别，PowerShell 对签名状态不明确时保留原文件。
const signatureProbe = String.raw`$ErrorActionPreference='Stop'
$s=Get-AuthenticodeSignature -LiteralPath $env:AGENTDECK_SIGNATURE_FILE
if ($s.Status -eq 'Valid') { [Console]::Write($s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)) }`;
async function signedBy(context: BackendContext, env: NodeJS.ProcessEnv, file: string, publisher: string) {
  const systemRoot = envValue(env, 'SystemRoot') ?? process.env.SystemRoot;
  if (!systemRoot) return false;
  const result = await context.run(
    path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', signatureProbe],
    {
      env: { ...env, AGENTDECK_SIGNATURE_FILE: file },
      timeoutMs: 15_000,
      outputCap: 4096,
    },
  );
  return result.exitCode === 0 && result.stdout.toString('utf8').trim() === publisher;
}
// Google 同时签署其他程序，用 AGY 的更新服务和专用环境变量区分产品；从不执行 .old 文件。
const markers = ['AGY_CLI_DISABLE_AUTO_UPDATE', 'antigravity-cli-auto-updater-974169037036.us-central1.run.app'];
async function agyProduct(file: string) {
  const missing = new Set(markers);
  let tail = Buffer.alloc(0);
  const overlap = Math.max(...markers.map((value) => value.length)) - 1;
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const data = Buffer.concat([tail, chunk as Buffer]);
    for (const marker of missing) if (data.includes(marker)) missing.delete(marker);
    if (!missing.size) return true;
    tail = data.subarray(-overlap);
  }
  return false;
}
export async function nativeRepairIdentity(
  context: BackendContext,
  installation: CliInstallation,
  env: NodeJS.ProcessEnv,
) {
  if (installation.source !== 'native' || !installation.command) return false;
  if (installation.agent === 'codex') return true; // 已核实双层入口、发布目录及架构。
  const file = installation.command.command;
  try {
    if (installation.agent === 'claude') return await signedBy(context, env, file, 'Anthropic, PBC');
    return (await signedBy(context, env, file, 'Google LLC')) && (await agyProduct(file));
  } catch {
    return false;
  }
}
async function cleanupCandidate(context: BackendContext, file: string, env: NodeJS.ProcessEnv) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 1024n ** 3n) return;
  if (!(await signedBy(context, env, file, 'Google LLC')) || !(await agyProduct(file))) return;
  await assertInstallationIdle(context, [file], AbortSignal.timeout(15_000));
  const after = await lstat(file, { bigint: true });
  if (before.dev === after.dev && before.ino === after.ino && before.ctimeNs === after.ctimeNs && after.isFile())
    await unlink(file);
}
export async function cleanupAgyHistory(context: BackendContext, dir: string, env: NodeJS.ProcessEnv) {
  if (!(await fixedDirectory(dir))) return;
  const current = path.join(dir, 'agy.exe');
  if (!(await signedBy(context, env, current, 'Google LLC')) || !(await agyProduct(current))) return;
  for (const name of await readdir(dir)) {
    if (/^agy\.exe\.[1-9]\d{18}\.old$/.test(name)) await cleanupCandidate(context, path.join(dir, name), env);
  }
}
