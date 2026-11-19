import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveLocalCommand } from '../../../server/src/platform/process/executable';
import { desktopRequestAllowed, type DesktopOwner, type DesktopRequest } from './window-access';

const encodedPowerShell = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

// 交互窗口继承真实控制台输入。可执行路径和参数不拼接成 PowerShell 命令。
const terminal = encodedPowerShell(`
$ErrorActionPreference = 'Stop'
try {
  $command = $env:AGENTDECK_AGY_LOGIN_COMMAND
  $prefix = @(ConvertFrom-Json -InputObject $env:AGENTDECK_AGY_LOGIN_ARGS)
  Remove-Item Env:AGENTDECK_AGY_LOGIN_COMMAND, Env:AGENTDECK_AGY_LOGIN_ARGS
  & $command @prefix 'acp' '--login'
  if ($LASTEXITCODE -eq 0) { exit 0 }
} catch {
  Write-Host '无法运行 Antigravity 登录命令。'
}
[void](Read-Host '登录未完成，按 Enter 关闭')
exit 1
`);

// Electron 是 GUI 进程，给 stdin 开管道不等于交互终端；另开窗口且只等待窗口进程的退出码。
const launcher = encodedPowerShell(`
$ErrorActionPreference = 'Stop'
try {
  $file = Join-Path $PSHOME 'powershell.exe'
  $argsForTerminal = @('-NoLogo', '-NoProfile', '-EncodedCommand', '${terminal}')
  $terminal = Start-Process -FilePath $file -ArgumentList $argsForTerminal -WindowStyle Normal -PassThru
  $terminal.WaitForExit()
  if ($terminal.ExitCode -eq 0) { exit 0 }
  exit 1
} catch { exit 2 }
`);

export async function runAntigravityLoginInTerminal(env: NodeJS.ProcessEnv): Promise<boolean> {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== 'win32' || !systemRoot) throw new Error('当前平台无法打开登录终端。');
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cli = resolveLocalCommand('agy', env);
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', launcher], {
      cwd: homedir(),
      env: {
        ...env,
        AGENTDECK_AGY_LOGIN_COMMAND: cli.command,
        AGENTDECK_AGY_LOGIN_ARGS: JSON.stringify(cli.args),
      },
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    child.once('error', () => reject(new Error('无法打开 Antigravity 登录终端。')));
    child.once('exit', (code) => {
      if (code === 0 || code === 1) resolve(code === 0);
      else reject(new Error('无法打开 Antigravity 登录终端。'));
    });
  });
}

/** 没有路径、参数或授权码输入，只允许本窗口同源的主 frame 发起固定原生命令。 */
export function createAntigravityLoginHandler(owner: DesktopOwner, url: string, launch: () => Promise<boolean>) {
  let pending: Promise<boolean> | undefined;
  return async (request: DesktopRequest): Promise<boolean> => {
    if (!desktopRequestAllowed(owner, url, request)) throw new Error('当前页面不能打开 Antigravity 登录终端。');
    pending ??= launch().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
