import { getSessionInfo, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { sameSessionDirectory } from '../../common/history/session-scope';
import { SessionError } from '../../errors';

const nativeInfo = (id: string, dir?: string) => getSessionInfo(id, dir ? { dir } : undefined);
export async function checkedClaudeInfo(record: SDKSessionInfo | undefined, id: string, dir: string) {
  if (!record || record.sessionId !== id || (record.cwd && !(await sameSessionDirectory(record.cwd, dir))))
    throw new SessionError(404, 'session_missing', 'Claude Code 在当前工作区中没有此会话');
  return record;
}
/** 只读定位兼容 Windows 短路径存储键；全局命中必须带有可核验的 cwd。 */
export async function resolveClaudeReadSource(
  id: string,
  dir: string,
  lookup: typeof nativeInfo = nativeInfo,
  globalFallback = true,
) {
  const scoped = await lookup(id, dir);
  const global = !scoped && globalFallback ? await lookup(id) : undefined;
  const info = await checkedClaudeInfo(scoped ?? (global?.cwd ? global : undefined), id, dir);
  return { info, dir: global ? undefined : dir };
}
