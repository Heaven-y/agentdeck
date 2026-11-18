import { lstat, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { BackendError, installationEnvironment, type BackendContext } from '../backend-support';

const rowSchema = z.object({
  name: z.string().min(1),
  pid: z.number().int().nonnegative().optional(),
  image: z.string().min(1).nullable(),
  argv: z.array(z.string()).nullish(),
});
type Row = z.infer<typeof rowSchema>;
const nodeImage = /^(?:node|nodejs)(?:\.exe)?$/i;
const unknown = () =>
  new BackendError('occupancy_unknown', '无法确认该份 CLI 安装是否空闲，请检查进程与读取权限后重试。');

// CIM 的命令行是单一字符串。交给 Windows 自己还原参数边界，只读取 Node 的参数用于入口判断。
const windowsProbe = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NodeArguments {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
  static extern IntPtr CommandLineToArgvW(string line, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
  public static string[] Read(string line) {
    int count;
    IntPtr ptr = CommandLineToArgvW(line, out count);
    if (ptr == IntPtr.Zero) throw new InvalidOperationException();
    try {
      var args = new string[count];
      for (int i=0; i<count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(ptr, i * IntPtr.Size));
      return args;
    } finally { LocalFree(ptr); }
  }
}
"@
$rows = @(Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath,CommandLine | ForEach-Object {
  $argsForNode = $null
  if ($_.Name -in 'node.exe','nodejs.exe' -and $_.CommandLine) { $argsForNode = [NodeArguments]::Read($_.CommandLine) }
  @{ pid = [int]$_.ProcessId; name = $_.Name; image = $_.ExecutablePath; argv = $argsForNode }
})
ConvertTo-Json -Compress -Depth 4 -InputObject $rows`;

// macOS 的 ps 会把参数压平。系统 Ruby 仅作只读系统接口的桥接，保留空格和 NUL 分隔的 argv。
const darwinProbe = String.raw`
require 'fiddle/import'
require 'json'
require 'etc'
module ProcInfo
  extend Fiddle::Importer
  dlload '/usr/lib/libproc.dylib', Fiddle.dlopen(nil)
  extern 'int proc_pidpath(int, void*, unsigned int)'
  extern 'int sysctl(void*, unsigned int, void*, void*, void*, size_t)'
end
def node_argv(pid)
  buf = "\0" * Etc.sysconf(Etc::SC_ARG_MAX)
  size = [buf.bytesize].pack('J')
  return nil unless ProcInfo.sysctl([1, 49, pid].pack('i*'), 3, buf, size, nil, 0) == 0
  # KERN_PROCARGS2 依次是 argc、映像路径、补齐字节、argv 和环境，只返回 argc 个参数。
  argc = buf.unpack1('i')
  data = buf.byteslice(4, size.unpack1('J') - 4)
  start = data.index("\0")
  return nil unless start && argc > 0
  start += 1 while data.getbyte(start) == 0
  Array.new(argc) do
    finish = data.index("\0", start)
    return nil unless finish
    arg = data.byteslice(start...finish)
    start = finish + 1
    arg
  end
end
list = IO.popen(['/bin/ps', '-A', '-o', 'pid=,ucomm='], &:read)
abort unless $?.success?
rows = list.lines.map do |line|
  pid, name = line.strip.split(/\s+/, 2)
  buf = "\0" * 4096
  size = ProcInfo.proc_pidpath(Integer(pid), buf, buf.bytesize)
  image = size > 0 ? buf.split("\0", 2).first : nil
  argv = node_argv(Integer(pid)) if ['node', 'nodejs'].include?(File.basename(image || name))
  {name: name, image: image, argv: argv}
end
puts JSON.generate(rows)`;

async function systemRows(context: BackendContext, signal: AbortSignal): Promise<Row[]> {
  const windows = context.platform === 'win32';
  if (!windows && context.platform !== 'darwin') throw unknown();
  const command = windows
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    : '/usr/bin/ruby';
  const args = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsProbe]
    : ['--disable-gems', '-e', darwinProbe];
  const result = await context.run(command, args, {
    signal,
    timeoutMs: 10_000,
    outputCap: 4 * 1024 * 1024,
    env: installationEnvironment(process.env),
  });
  if (result.exitCode !== 0) throw unknown();
  return rowSchema
    .array()
    .min(1)
    .parse(JSON.parse(result.stdout.toString('utf8')));
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH');
}
async function linuxRow(pid: string): Promise<Row | undefined> {
  const base = `/proc/${pid}`;
  const image = await readlink(`${base}/exe`).catch(() => null);
  if (!image) {
    try {
      return { name: (await readFile(`${base}/comm`, 'utf8')).trimEnd(), image: null };
    } catch (error) {
      if (missing(error)) return undefined; // 已在枚举期间退出。
      throw error;
    }
  }
  const name = path.basename(image);
  if (!nodeImage.test(name)) return { name, image };
  const data = await readFile(`${base}/cmdline`).catch(() => null);
  const argv = data?.at(-1) === 0 ? data.subarray(0, -1).toString('utf8').split('\0') : null;
  return { name, image, argv };
}
async function* processRows(context: BackendContext, signal: AbortSignal): AsyncGenerator<Row> {
  if (context.platform !== 'linux') {
    yield* await systemRows(context, signal);
    return;
  }
  // hidepid 可以直接从目录清单隐藏进程，不能把这样的清单当成完整快照。
  const mounts = await readFile('/proc/self/mounts', 'utf8');
  const options = mounts
    .split('\n')
    .find((line) => line.split(' ')[1] === '/proc')
    ?.split(' ')[3];
  if (!options || /(?:^|,)hidepid=(?!0(?:,|$)|off(?:,|$))/.test(options)) throw unknown();
  const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
  if (!pids.length) throw unknown();
  for (const pid of pids) {
    signal.throwIfAborted();
    const row = await linuxRow(pid);
    if (row) yield row;
  }
}

type Targets = { files: Set<string>; directories: string[]; names: Set<string>; scripts: boolean };
async function addTarget(target: string, targets: Targets) {
  if (!path.isAbsolute(target)) throw unknown();
  // 只忽略目录项本身不存在。已有链接断开、目录不可读或解析期间消失都保留失败。
  const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!entry) return;
  const resolved = await realpath(target);
  const info = entry.isSymbolicLink() ? await stat(resolved) : entry;
  targets.names.add(path.basename(target).toLowerCase());
  targets.names.add(path.basename(resolved).toLowerCase());
  if (info.isDirectory()) {
    targets.directories.push(resolved);
    targets.scripts = true;
    // 名称只用于排除受保护的无关系统进程，不能作为占用证据。
    for (const child of await readdir(resolved, { recursive: true, withFileTypes: true })) {
      if (!child.isDirectory()) targets.names.add(child.name.toLowerCase());
    }
  } else if (info.isFile()) {
    targets.files.add(resolved);
    if (!/\.(?:exe|com)$/i.test(resolved)) targets.scripts = true;
  } else throw unknown();
}

async function approvedTargets(paths: string[], signal: AbortSignal): Promise<Targets> {
  const targets: Targets = { files: new Set(), directories: [], names: new Set(), scripts: false };
  if (!paths.length) throw unknown();
  for (const target of new Set(paths)) {
    signal.throwIfAborted();
    await addTarget(target, targets);
  }
  signal.throwIfAborted();
  return targets;
}

function contains(targets: Targets, file: string): boolean {
  if (targets.files.has(file)) return true;
  return targets.directories.some((dir) => {
    const rel = path.relative(dir, file);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

const withValue = new Set([
  '--require',
  '-r',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--env-file',
  '--input-type',
]);
const withoutValue = new Set([
  '--no-warnings',
  '--trace-warnings',
  '--enable-source-maps',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--inspect',
  '--inspect-brk',
  '--experimental-modules',
  '--experimental-import-meta-resolve',
]);
function nodeEntry(argv: Row['argv']): string | undefined {
  if (!argv || !nodeImage.test(path.basename(argv[0] ?? ''))) throw unknown();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') return argv[i + 1];
    if (/^(?:-$|-[ep]|--(?:eval|print)(?:=|$))/.test(arg)) return undefined;
    if (!arg.startsWith('-')) return arg;
    if (withValue.has(arg)) i++;
    else if (!knownFlag(arg)) throw unknown();
  }
}
function knownFlag(arg: string): boolean {
  if (withoutValue.has(arg)) return true;
  const pos = arg.indexOf('=');
  if (pos < 1) return false;
  const flag = arg.slice(0, pos);
  return withValue.has(flag) || withoutValue.has(flag) || flag === '--max-old-space-size';
}

function possibleImage(targets: Targets, name: string, platform: NodeJS.Platform): boolean {
  const key = name.toLowerCase().replace(/ \(deleted\)$/, '');
  if (targets.names.has(key)) return true;
  // Unix 的短进程名可能被内核按字节截断。
  return platform !== 'win32' && [...targets.names].some((candidate) => candidate.startsWith(key));
}
async function occupied(row: Row, targets: Targets, platform: NodeJS.Platform): Promise<boolean> {
  const image = row.image && path.isAbsolute(row.image) ? await realpath(row.image).catch(() => null) : null;
  if (image && contains(targets, image)) return true;
  const inspectEntry = targets.scripts && nodeImage.test(path.basename(image ?? row.name));
  if (!image && possibleImage(targets, row.name, platform)) throw unknown();
  if (!inspectEntry) return false;
  return occupiedScript(row.argv, targets);
}
async function occupiedScript(argv: Row['argv'], targets: Targets): Promise<boolean> {
  const entry = nodeEntry(argv);
  if (entry === undefined) return false;
  // 进程当前 cwd 可能已经改变，不能用服务端 cwd 或猜测启动目录来解相对入口。
  if (!path.isAbsolute(entry)) {
    // 目录内有同名脚本时相对路径无法消歧。其它项目自己的明确脚本名不占用本安装。
    const base = path.basename(entry).toLowerCase();
    if (['', '.js', '.json', '.node'].some((suffix) => targets.names.has(base + suffix))) throw unknown();
    return false;
  }
  const actualEntry = createRequire(import.meta.url).resolve(entry);
  return contains(targets, await realpath(actualEntry));
}

// CIM 可能在进程退出时保留名称却已取不到参数，PID 仍在且无权限时必须保留未知。
function alreadyExited(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** 仅核对本机可见的进程映像和 Node 主入口。调用方应在实际改写已核准目标前尽量靠近地调用。 */
export async function assertInstallationIdle(
  context: BackendContext,
  targets: string[],
  signal: AbortSignal,
): Promise<void> {
  try {
    signal.throwIfAborted();
    const approved = await approvedTargets(targets, signal);
    if (!approved.names.size) return;
    let incomplete = false;
    for await (const row of processRows(context, signal)) {
      signal.throwIfAborted();
      const match = await occupied(row, approved, context.platform).catch(() => {
        if (!alreadyExited(row.pid)) incomplete = true;
        return false;
      });
      if (match) throw new BackendError('agent_busy', '该份 CLI 安装正在使用，请结束使用它的会话后重试。');
    }
    signal.throwIfAborted();
    if (incomplete) throw unknown();
  } catch (error) {
    if (signal.aborted) throw new BackendError('aborted', 'CLI 占用检测已取消。');
    if (error instanceof BackendError) throw error;
    throw unknown();
  }
}
