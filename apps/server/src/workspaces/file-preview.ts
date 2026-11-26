import path from 'node:path';
import { mkdtemp, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { WorkspaceFilePreview } from '@agentdeck/shared/projects';
import { inspectDirectory, assertDirectoryUnchanged, readConfigFile } from '../platform/files/safe-file';
import { runProcess } from '../platform/process/run';

export class FilePreviewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function workspacePath(root: string, requested: string) {
  if (/^[\\/]{2}|[\0\r\n]/.test(requested)) throw new FilePreviewError('请选择工作区内的文件。');
  const file = path.resolve(root, requested);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative))
    throw new FilePreviewError('请选择工作区内的文件。');
  if (
    relative.split(path.sep).some((part) => part.toLowerCase() === '.git') ||
    (process.platform === 'win32' && relative.includes(':'))
  )
    throw new FilePreviewError('此路径不支持预览。');
  return { file, relative: relative.split(path.sep).join('/') };
}

async function textFile(file: string, allowMissing: boolean) {
  const directories = await inspectDirectory(path.dirname(file));
  if (!directories) {
    if (allowMissing) return '';
    throw new FilePreviewError('文件不存在。', 404);
  }
  const snapshot = await readConfigFile(file);
  if (snapshot.revision === 'missing' && !allowMissing) throw new FilePreviewError('文件不存在。', 404);
  await assertDirectoryUnchanged(directories);
  if (snapshot.content.includes('\0')) throw new FilePreviewError('此文件不是可预览的文本。');
  return snapshot.content;
}

const gitEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
});

async function gitDiff(root: string, file: string, content: string, signal?: AbortSignal): Promise<string> {
  const options = { cwd: root, env: gitEnvironment(), timeoutMs: 5000, outputCap: 512 * 1024, signal };
  const repository = await runProcess(
    'git',
    ['--no-pager', '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
    options,
  );
  if (repository.exitCode !== 0) throw new FilePreviewError('当前目录没有 Git 记录。');
  const repositoryRoot = repository.stdout.toString('utf8').trim();
  const canonical = path.resolve(await realpath(root), path.relative(root, file));
  const relative = path.relative(repositoryRoot, canonical).split(path.sep).join('/');
  const baselineOptions = { ...options, cwd: repositoryRoot };
  const tracked = await runProcess(
    'git',
    [
      '--no-pager',
      '--literal-pathspecs',
      '-c',
      'core.fsmonitor=false',
      'ls-tree',
      '--name-only',
      'HEAD',
      '--',
      relative,
    ],
    baselineOptions,
  );
  if (tracked.exitCode !== 0) throw new FilePreviewError('无法读取 Git 基线，请检查仓库的提交记录。');
  const original = tracked.stdout.length
    ? await runProcess('git', ['--no-pager', '-c', 'core.fsmonitor=false', 'show', `HEAD:${relative}`], baselineOptions)
    : undefined;
  if (original && original.exitCode !== 0) throw new FilePreviewError('暂时无法读取 Git 中的文件。');
  const temporary = await mkdtemp(path.join(tmpdir(), 'agentdeck-file-diff-'));
  const before = path.join(temporary, 'before'),
    after = path.join(temporary, 'after');
  try {
    await writeFile(before, original?.stdout ?? '');
    await writeFile(after, content);
    // 在独立目录比较内容，不执行项目 attributes 的过滤器或外部 diff。
    const result = await runProcess(
      'git',
      ['--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', 'before', 'after'],
      { ...options, cwd: temporary },
    );
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new FilePreviewError('暂时无法读取文件改动。');
    return result.stdout.toString('utf8');
  } finally {
    await unlink(before).catch(() => undefined);
    await unlink(after).catch(() => undefined);
    await rmdir(temporary);
  }
}

export async function readWorkspaceFile(
  root: string,
  requested: string,
  diff: boolean,
  signal?: AbortSignal,
): Promise<WorkspaceFilePreview> {
  try {
    signal?.throwIfAborted();
    const { file, relative } = workspacePath(root, requested);
    const content = await textFile(file, diff);
    const result = diff ? await gitDiff(root, file, content, signal) : content;
    signal?.throwIfAborted();
    return { path: relative, content: result, view: diff ? 'diff' : 'content' };
  } catch (error) {
    if (error instanceof FilePreviewError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'too_large') throw new FilePreviewError('文件超过 256 KiB，请在编辑器中查看。', 413);
    if (code === 'invalid_utf8') throw new FilePreviewError('此文件不是 UTF-8 文本。');
    if (code === 'unsafe_path') throw new FilePreviewError('此文件链接不支持预览。');
    throw new FilePreviewError('暂时无法读取文件，请刷新重试。', 503);
  }
}
